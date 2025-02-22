const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const express = require('express');
const { LLMChat } = require('./llm-config/chat');
const { getTTSAudioContent } = require('./text-to-speech');
const { transcribeAudio } = require('./speech-to-text');
const { sendOtpMail } = require('./sendEmail');
const { sendOtpPhone } = require('./sendSMS');
const { default: mongoose } = require('mongoose');
const { User } = require('./models/User');
const { uploadUsersImage } = require('./storage');
const { extractFaceEmbeddings, authenticateUserImage } = require('./Auth');
const router = require('./routes');
const enrichUserProfile = require('./enrich-profile');
const { validateUserImage } = require('./vision');
require('dotenv').config();
require('./llm-config');

const mailOtpCache = {};
const phoneOtpCache = {};
const uidCache = {};
const onboardingUserCache = {};
const authCache = {};

const app = express();
const httpServer = http.createServer(app);
const socketServer = new Server(httpServer, { cors: { origin: '*' } });

const authenticationSocket = socketServer.of('/auth');

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded());
app.use('/', router);

authenticationSocket.on('connection', async socket => {
  socket.on('authenticate', async data => {
    const email = data.email;
    try {
      if (authCache[email]) return;
      authCache[email] = true;
      const user = await User.findOne({ email });
      const isAuthenticated = await authenticateUserImage(
        data.image,
        user.embeddings
      );
      if (isAuthenticated) {
        socket.emit('events', 'success');
        await User.findOneAndUpdate(
          { email },
          { $addToSet: { machineIds: data.machineId } }
        );
      } else {
        socket.emit('events', 'failed');
      }
      authCache[email] = false;
    } catch (error) {
      socket.emit('events', 'error');
      authCache[email] = false;
      console.log(error.message);
    }
  });
});

const onboardingSocket = socketServer.of('/onboarding');
onboardingSocket.on('connection', async socket => {
  const machineId = socket.handshake?.query?.machineId;
  const llmChat = new LLMChat();
  try {
    let locationData = socket.handshake?.query?.locationData;
    if (locationData) locationData = JSON.parse(locationData);
    onboardingUserCache[machineId] = { locationData };
    const welcomeMessage = await llmChat.signalLLM(
      `start onboarding, and this is the location data of the user ${locationData?.fullAddress}`
    );
    const audioContent = await getTTSAudioContent(welcomeMessage.response);
    socket.emit('tts', audioContent);
    socket.emit('welcome', welcomeMessage.response);
  } catch (error) {
    console.log(error.message);
  }

  socket.on('audio', async audioChunk => {
    try {
      let transcribedText;
      try {
        transcribedText = await transcribeAudio(audioChunk);
        if (
          transcribedText == '' ||
          transcribedText == null ||
          !transcribedText
        )
          throw new Error('Error transcribing');
      } catch (error) {
        return socket.emit('events', 'error_transcribing');
      }
      socket.emit('transcribe', transcribedText);
      await interactWithLLm(transcribedText, llmChat, socket);
    } catch (error) {
      console.log(error.message);
      return console.log('Error transcribing');
    }
  });

  socket.on('image', async imageData => {
    try {
      const machineId = socket.handshake?.query?.machineId;
      // public acces disabled  by  org;
      const result = await validateUserImage(imageData);
      if (result.error) {
        return await signalLLM(
          `The uploaded image by user has validation errors, this is the validation error observed the by the system Error: ${result.error},
          Please convey it user and reintiate capturing user image`,
          socket,
          llmChat
        );
      }
      const publicUrl = await uploadUsersImage(imageData);
      const embeddings = await extractFaceEmbeddings(imageData);
      onboardingUserCache[machineId].userImageData = {
        imageUrl: publicUrl,
        embeddings,
      };

      await signalLLM(
        'user has uploaded the photo and the system has procecced it, you may continue collecting the rest of the data',
        socket,
        llmChat
      );
    } catch (error) {
      console.log('ERror  in Image processing: ', error.message);
    }
  });
  socket.on('message', async msg => {
    try {
      await interactWithLLm(msg, llmChat, socket);
    } catch (error) {
      console.log(error.message);
    }
  });
});

async function interactWithLLm(msg, llmChat, socket) {
  const machineId = socket.handshake?.query?.machineId;
  const llmResponse = await llmChat.interactWithLLM(msg);
  console.log(llmResponse);
  onboardingUserCache[machineId].collectedUserData = llmResponse.collectedData;
  const audioContent = await getTTSAudioContent(llmResponse.response);
  socket.emit('tts', audioContent);
  socket.emit('ai', llmResponse?.response);

  await handleCrawlData(llmResponse, socket, llmChat);
  await handleCapturePicture(llmResponse, socket);
  await handleEmailOtpVerify(llmResponse, socket, llmChat);
  await handleEmailVerify(llmResponse, socket, llmChat);
  await handleGenerateUID(llmResponse, socket, llmChat);
  await handleOnboardingSessionEnd(llmResponse, socket);
  await handlePhoneVerify(llmResponse, socket, llmChat);
  await handlePhoneOtpVerify(llmResponse, socket, llmChat);
}

async function handleCrawlData(llmResponse, socket, llmChat) {
  if (llmResponse.signal !== 'crawl_data') return;
  try {
    const crawledData = await enrichUserProfile(llmResponse.collectedData);
    await signalLLM(
      `This is the stringified crawledData ${JSON.stringify(crawledData)}
    If it is null or empty, skip and continue, else confirm the data with the user and only save it if user agrees, try convincing if they don't but don't compell`,
      socket,
      llmChat
    );
  } catch (error) {
    return signalLLM(
      `There was an error while crawling user data and could not proceed at this moment,
      for now  skip  this  step and kindly convey this to user and continue the onboarding process accordingly`,
      socket,
      llmChat
    );
  }
}

async function handleCapturePicture(llmResponse, socket) {
  if (llmResponse.signal !== 'capture_picture') return;
  socket.emit('events', 'capture_picture');
}

async function handleOnboardingSessionEnd(llmResponse, socket) {
  if (llmResponse.signal !== 'session_end') return;
  socket.emit('events', 'session_end');
  const email = llmResponse.collectedData.email;
  await User.updateOne({ email }, { uid: uidCache[email] });
}

async function handlePhoneOtpVerify(llmResponse, socket, llmChat) {
  if (llmResponse.signal !== 'verify_otp_phone') return;
  const phoneNumber = llmResponse.collectedData.phoneNumber;
  const otp = llmResponse.phoneOtp;
  if (!phoneNumber) return;
  if (!otp) return;
  if (phoneOtpCache[phoneNumber] != otp) {
    return await signalLLM(
      'The otp for phone verification provided by user is wrong. Please let them know and kindly ask them to recheck. Also make the variable <phoneOtp> null again ',
      socket,
      llmChat
    );
  }

  return await signalLLM(
    `The otp for phone verification is correct. mark the users phoneNumber is verified and kindly let them know they have verified their phoneNumber.`,
    socket,
    llmChat
  );
}

async function handlePhoneVerify(llmResponse, socket, llmChat) {
  if (llmResponse.signal !== 'send_verification_phone') return;
  const phoneNumber = llmResponse.collectedData.phoneNumber;
  const userDoc = await User.findOne({ phoneNumber });
  if (userDoc) {
    return signalLLM(
      `This phone number is already in use. Please notify the user we can't continue
      with a already in use phoneNumber. Ask if they have alternative options else convey  we can't proceed with this phoneNumber`,
      socket,
      llmChat
    );
  }
  const otp = await sendOtpPhone(phoneNumber);
  console.log(otp);
  phoneOtpCache[phoneNumber] = otp;
  await signalLLM(
    "Have sent a verification sms to the user's phone number. Please notify them",
    socket,
    llmChat
  );
}

async function generateUniqueUID(firstName) {
  let uid;
  let user;
  do {
    uid = generateUID(firstName);
    user = await User.findOne({ uid });
  } while (user);
  return uid;
}

async function handleGenerateUID(llmResponse, socket, llmChat) {
  if (llmResponse.signal !== 'generate_uid') return;
  const machineId = socket.handshake?.query?.machineId;
  const { locationLabel, ...rest } = llmResponse.collectedData;
  await User.create({
    ...rest,
    machineIds: [machineId],
    embeddings: onboardingUserCache[machineId].userImageData.embeddings,
    imageUrl: onboardingUserCache[machineId].userImageData.imageUrl,
    locations: [
      {
        label: locationLabel,
        current: true,
        ...onboardingUserCache[machineId].locationData,
      },
    ],
  });
  const uid = await generateUniqueUID(llmResponse.collectedData.firstName);
  uidCache[llmResponse.collectedData.email] = uid;
  return await signalLLM(
    `Have generated UID for the user.
    This is  their uid ${uid}. 
    Please let them save it and confirm it`,
    socket,
    llmChat
  );
}

async function handleEmailOtpVerify(llmResponse, socket, llmChat) {
  if (llmResponse.signal !== 'verify_otp_mail') return;
  const email = llmResponse.collectedData.email;
  const otp = llmResponse.emailOtp;
  if (!email) return;
  if (!otp) return;
  if (mailOtpCache[email] != otp) {
    return await signalLLM(
      'The otp provided by user for mail verification is wrong. Please let them know and kindly ask them to recheck. Also make the variable <emailOtp> null again ',
      socket,
      llmChat
    );
  }

  return await signalLLM(
    `The otp for mail verification is correct. mark the users email is verified and kindly let them know they have verified their email.
`,
    socket,
    llmChat
  );
}

async function handleEmailVerify(llmResponse, socket, llmChat) {
  if (llmResponse.signal !== 'send_verification_mail') return;
  const email = llmResponse.collectedData.email;

  const userDoc = await User.findOne({ email });
  if (userDoc) {
    return signalLLM(
      'The email is already in use. Please notify the user this. Ask them if they have any alternative options else convey them we cant proceed with a email that is  already in use',
      socket,
      llmChat
    );
  }
  const otp = await sendOtpMail(email);
  console.log(otp);
  mailOtpCache[email] = otp;
  await signalLLM(
    'Have sent a verification mail to the user. Please notify them',
    socket,
    llmChat
  );
}

async function signalLLM(message, socket, llmChat) {
  const llmResponse = await llmChat.signalLLM(message);
  const audioContent = await getTTSAudioContent(llmResponse.response);
  socket.emit('tts', audioContent);
  socket.emit('ai', llmResponse.response);
}

function generateUID(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Name must be a non-empty string');
  }

  const initials = name
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3);

  const randomPart = Array.from({ length: 13 }, () =>
    Math.random().toString(36).charAt(2)
  )
    .join('')
    .toUpperCase();

  return initials + randomPart;
}

mongoose
  .connect(process.env.MONGODB_URL)
  .then(() => {
    console.log('Connected to MongoDB');
    httpServer.listen(8000, () => console.log('Server listening on port 8000'));
  })
  .catch(err => console.log(err));
