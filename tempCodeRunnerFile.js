const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const multer = require("multer");
const path = require("path");
require("dotenv").config(); // For environment variables
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();

// Set up multer for file uploads (image for SMS)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // Folder to store uploaded images
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // File name with timestamp
  },
});
const upload = multer({ storage: storage });

// Twilio client setup
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Google Generative AI client setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Serve static files (HTML, CSS, JS, etc.)
app.use(express.static("public"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

// Log the Twilio phone number to ensure it's being loaded correctly
console.log("Twilio Phone Number:", process.env.TWILIO_PHONE_NUMBER);

// Route to serve the dashboard.html file (on root path "/")
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/dashboard.html");
});

// Serve index.html when /index.html is accessed
app.get("/index.html", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Serve call.html
app.get("/call", (req, res) => {
  res.sendFile(__dirname + "/public/call.html");
});

// Serve sms.html
app.get("/sms", (req, res) => {
  res.sendFile(__dirname + "/public/sms.html");
});

// Route to make a call
app.post("/make-call", async (req, res) => {
  const { to } = req.body; // The phone number to call

  try {
    const call = await client.calls.create({
      url: `${process.env.NGROK_URL}/voice-response`, // Twilio will fetch instructions here
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
    });

    console.log("Call initiated:", call.sid);
    res.status(200).send({ success: true, message: "Call initiated" });
  } catch (error) {
    console.error("Twilio Error:", error.message);
    res.status(500).send({
      success: false,
      message: "Failed to initiate call",
      details: error.message,
    });
  }
});

// Route to send SMS
app.post("/send-sms", upload.single("smsImage"), async (req, res) => {
  const { to, message } = req.body; // The phone number and message

  const mediaUrl = req.file
    ? `${process.env.NGROK_URL}/uploads/${req.file.filename}`
    : null;

  try {
    const sms = await client.messages.create({
      body: message,
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      mediaUrl: mediaUrl ? [mediaUrl] : undefined, // Include media if uploaded
    });

    console.log("SMS sent:", sms.sid);
    res.status(200).send({ success: true, message: "SMS sent successfully" });
  } catch (error) {
    console.error("Twilio Error:", error.message);
    res.status(500).send({
      success: false,
      message: "Failed to send SMS",
      details: error.message,
    });
  }
});

// Route for voice response (greeting) to listen for speech input
app.post("/voice-response", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Prompt user to press 1 to start speaking to the AI chatbot
  const gather = twiml.gather({
    input: "dtmf", // Collecting DTMF input (Press 1 to continue)
    action: "/collect-input", // Redirect to process the input
    method: "POST",
    numDigits: 1, // Only expect 1 digit
  });

  gather.say("Welcome! Press 1 to start chatting with our AI chatbot.");

  // If no input, ask again
  twiml.redirect("/voice-response");

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// Route to process input from DTMF (Press 1 to start)
app.post("/collect-input", (req, res) => {
  const userInput = req.body.Digits;

  const twiml = new twilio.twiml.VoiceResponse();

  if (userInput === "1") {
    // If user presses 1, start the speech interaction
    twiml.say("Great! You can now speak with the AI chatbot.");
    twiml
      .gather({
        input: "speech", // Listen for speech input
        action: "/process-speech", // Redirect to process speech
        method: "POST",
        timeout: 5, // Wait for 5 seconds of silence before triggering response
        speechTimeout: "auto", // Automatically handle speech timeout
      })
      .say("Please say something to start the conversation.");
  } else {
    twiml.say("Invalid input. Please press 1 to start.");
    twiml.redirect("/voice-response"); // If not pressing 1, ask again
  }

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// Route to process speech input and generate responses with Gemini
app.post("/process-speech", async (req, res) => {
  const userSpeech = req.body.SpeechResult; // Speech result

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (userSpeech) {
      // Enhanced prompt generation for better responses
      let prompt = "";

      // Handle specific user queries like "suggest me some options"
      if (
        userSpeech.toLowerCase().includes("suggest") ||
        userSpeech.toLowerCase().includes("recommend")
      ) {
        prompt = `The user is asking for suggestions or recommendations. Respond with a list of options based on the context. The user said: "${userSpeech}". Provide options for products or services that match this request. Keep the response informative and concise.`;
      } else {
        // Default conversational response
        prompt = `The user said: "${userSpeech}". Generate a response based on this input in a natural conversational tone. Keep the response brief, under 15 seconds.`;
      }

      // Get the Gemini model for response generation
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
      const result = await model.generateContent(prompt);
      const aiResponse = result.response.text(); // Gemini's response

      twiml.say(aiResponse); // Read the response from Gemini

      // Continue gathering speech input for the ongoing conversation
      twiml.gather({
        input: "speech",
        action: "/process-speech", // Continue conversation based on next input
        method: "POST",
        timeout: 5, // Timeout set to 5 seconds
        speechTimeout: "auto",
      });
    } else {
      twiml.say("Sorry, I didn't catch that. Could you please repeat?");
      twiml.redirect("/voice-response"); // Retry if input is unclear
    }
  } catch (error) {
    console.error("Error from Gemini:", error.message);
    twiml.say("Sorry, there was an error processing your request.");
    twiml.redirect("/voice-response"); // Retry on error
  }

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
