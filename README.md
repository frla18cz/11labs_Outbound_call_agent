# Eleven Labs Outbound Caller  

This project demonstrates the integration of **Eleven Labs Conversational AI** with **Twilio** to enable seamless real-time interactions during outbound and inbound phone calls. The system leverages WebSockets for media streaming and integrates Eleven Labs' advanced conversational AI capabilities for human-like interactions.

---

## Features  
- **Outbound Call Integration**: Programmatically initiate outbound calls using Twilio’s API.  
- **Real-Time Media Streaming**: Connect calls to Eleven Labs via WebSockets for audio input and output.  
- **AI-Powered Conversations**: Use Eleven Labs Conversational AI to create dynamic, human-like dialogues.  
- **Simple API Setup**: Easily configure and deploy the project for real-time call control and monitoring.

---

## Getting Started  

Follow these steps to set up and run the project:  

### 1. Clone the Repository  
```bash
git clone https://github.com/esplanadeai/11labs_Outbound.git
```

### 2. Navigate to the Project Directory
```bash
cd 11labs_Outbound
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Configure the Environment
Create your `.env` from the provided template and fill in real credentials:
```bash
cp .env.example .env
```

Update the generated `.env` file with values for:
- `ELEVENLABS_AGENT_ID`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `PUBLIC_URL` (use `http://localhost:8000` when testing locally)
### 5. Start the Server
```bash
node index.js
```

### 6. Start Ngrok
Expose your local server to the internet using Ngrok. Run the following command in a new terminal:
```bash
ngrok http 8000
```
### 7. Test the System
For Outbound Calls:
Send a POST request to the /make-outbound-call endpoint with the recipient’s phone number:
```json
curl -X POST http://localhost:8000/make-outbound-call \
-H "Content-Type: application/json" \
-d '{"to": "+1234567890"}'
```
