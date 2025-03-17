import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";
import fs from "fs";
import path from "path";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PUBLIC_URL
} = process.env;

// Check for the required environment variables
if (!ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Validate PUBLIC_URL
const serverUrl = PUBLIC_URL ? PUBLIC_URL.trim() : null;
if (!serverUrl) {
  console.warn("Warning: PUBLIC_URL is not set in .env file");
  console.warn("This might cause issues with callback URLs");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Initialize Twilio client
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const PORT = process.env.PORT || 8000;

// Přidání CSV loggeru
const CSV_FILE_PATH = path.join(process.cwd(), 'call_history.csv');
const CSV_HEADER = 'timestamp,callSid,from,to,status,answered,duration,notes\n';

// Vytvoření CSV souboru, pokud neexistuje
if (!fs.existsSync(CSV_FILE_PATH)) {
  fs.writeFileSync(CSV_FILE_PATH, CSV_HEADER);
  console.log(`[Server] Created call history CSV file at ${CSV_FILE_PATH}`);
}

// Funkce pro zápis výsledku hovoru do CSV
function logCallToCSV(callData) {
  try {
    const { callSid, from, to, status, duration, notes = '' } = callData;
    const timestamp = new Date().toISOString();
    
    // Upravena logika pro nastavení hodnoty "answered"
    let answered = 'NE';
    if (status === 'completed' || status === 'in-progress') {
      answered = 'ANO';
    } else if (status === 'voicemail') {
      answered = 'VOICEMAIL';
    }
    
    const csvLine = `${timestamp},"${callSid}","${from}","${to}","${status}","${answered}",${duration || 0},"${notes}"\n`;
    fs.appendFileSync(CSV_FILE_PATH, csvLine);
    console.log(`[Server] Call logged to CSV: ${callSid}`);
  } catch (error) {
    console.error('[Server] Error logging call to CSV:', error);
  }
}

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio
fastify.all("/incoming-call-eleven", async (request, reply) => {
  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Nový endpoint pro přijímání aktualizací stavu hovoru
fastify.post("/call-status", async (request, reply) => {
  try {
    console.log("[Twilio Webhook Debug] Received data:", JSON.stringify(request.body));
    
    const { CallSid, CallStatus, To, From, CallDuration, AnsweredBy } = request.body;
    
    // Detekce voicemail a automatických odpovědí (AnsweredBy je Twilio parametr)
    const isVoicemail = AnsweredBy === 'machine_start' || AnsweredBy === 'machine_end';
    const isHuman = AnsweredBy === 'human';
    
    // Vizuálně odlišený výstup podle stavu hovoru
    let statusMessage = '';
    switch(CallStatus) {
      case 'initiated':
        statusMessage = `🟡 ZAHÁJENO: Hovor na ${To} byl zahájen`;
        break;
      case 'ringing':
        statusMessage = `🔔 VYZVÁNĚNÍ: Telefon ${To} zvoní`;
        break;
      case 'in-progress':
        // Rozlišení mezi člověkem a hlasovou schránkou
        if (isVoicemail) {
          statusMessage = `📼 VOICEMAIL: Hovor s ${To} přešel do hlasové schránky`;
          
          // Zápis do CSV s informací o voicemailu
          logCallToCSV({
            callSid: CallSid,
            from: From,
            to: To,
            status: 'voicemail',
            duration: 0
          });
          
          // Zde můžete přidat kód pro ukončení hovoru při detekci voicemailu
          try {
            await twilioClient.calls(CallSid).update({status: 'completed'});
            console.log(`[Twilio] Call ${CallSid} was terminated because it went to voicemail`);
          } catch (hangupError) {
            console.error(`[Twilio] Failed to hangup voicemail call: ${hangupError}`);
          }
        } else if (isHuman) {
          statusMessage = `🟢 PŘIJATO ČLOVĚKEM: Hovor s ${To} je aktivní`;
        } else {
          statusMessage = `🟢 PŘIJATO: Hovor s ${To} je aktivní`;
        }
        break;
      case 'completed':
        statusMessage = `🔵 UKONČENO: Hovor s ${To} skončil, trval ${CallDuration || 'N/A'} sekund`;
        // Zápis do CSV při ukončení hovoru
        logCallToCSV({
          callSid: CallSid,
          from: From,
          to: To,
          status: CallStatus,
          duration: CallDuration
        });
        break;
      case 'busy':
        statusMessage = `⛔ OBSAZENO: Číslo ${To} je obsazené`;
        // Zápis do CSV při obsazeném hovoru
        logCallToCSV({
          callSid: CallSid,
          from: From,
          to: To,
          status: CallStatus,
          duration: 0
        });
        break;
      case 'no-answer':
        statusMessage = `❌ BEZ ODPOVĚDI: Číslo ${To} neodpovídá`;
        // Zápis do CSV při neodpovídání
        logCallToCSV({
          callSid: CallSid,
          from: From,
          to: To,
          status: CallStatus,
          duration: 0
        });
        break;
      case 'failed':
        statusMessage = `⚠️ SELHALO: Hovor na ${To} selhal`;
        // Zápis do CSV při selhání
        logCallToCSV({
          callSid: CallSid,
          from: From,
          to: To,
          status: CallStatus,
          duration: 0
        });
        break;
      default:
        statusMessage = `Stav hovoru: ${CallStatus}`;
    }
    
    console.log(`[Twilio] ${statusMessage} (SID: ${CallSid})`);
    console.log(`[Twilio Detail] SID: ${CallSid}, From: ${From}, To: ${To}, Status: ${CallStatus}${CallDuration ? ', Duration: ' + CallDuration + 's' : ''}${AnsweredBy ? ', AnsweredBy: ' + AnsweredBy : ''}`);
    
    reply.send({ received: true });
  } catch (error) {
    console.error("[Twilio] Error processing call status webhook:", error);
    reply.status(500).send({ error: "Failed to process call status update" });
  }
});

// Endpoint pro kontrolu stavu konkrétního hovoru
fastify.get("/call-status/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  
  if (!callSid) {
    return reply.status(400).send({ error: "Call SID is required" });
  }
  
  try {
    const call = await twilioClient.calls(callSid).fetch();
    console.log(`[Twilio] Call ${callSid} status: ${call.status}, to: ${call.to}, duration: ${call.duration}s`);
    
    reply.send({
      callSid: call.sid,
      to: call.to,
      from: call.from,
      status: call.status,
      startTime: call.startTime,
      endTime: call.endTime,
      duration: call.duration
    });
  } catch (error) {
    console.error("[Twilio] Error fetching call:", error);
    reply.status(500).send({ error: "Failed to fetch call status" });
  }
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");

    let streamSid = null;
    let connectionActive = true;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    
    // Timeout pro kontrolu WebSocket spojení (watchdog)
    let connectionWatchdog = null;
    
    // Connect to ElevenLabs Conversational AI WebSocket
    let elevenLabsWs = null;
    
    function connectToElevenLabs() {
      if (elevenLabsWs && elevenLabsWs.readyState !== WebSocket.CLOSED) {
        elevenLabsWs.close();
      }
      
      try {
        elevenLabsWs = new WebSocket(
          `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
        );

        elevenLabsWs.on("open", () => {
          console.log("[II] Connected to Conversational AI.");
          reconnectAttempts = 0; // Reset counter on successful connection
          
          // Nastav watchdog
          clearTimeout(connectionWatchdog);
          connectionWatchdog = setTimeout(checkConnection, 30000);
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);
            handleElevenLabsMessage(message, connection);
            
            // Reset watchdog timer on each message
            clearTimeout(connectionWatchdog);
            connectionWatchdog = setTimeout(checkConnection, 30000);
          } catch (error) {
            console.error("[II] Error parsing message:", error);
          }
        });

        elevenLabsWs.on("error", (error) => {
          console.error("[II] WebSocket error:", error);
          attemptReconnect();
        });

        elevenLabsWs.on("close", () => {
          console.log("[II] Disconnected.");
          clearTimeout(connectionWatchdog);
          
          if (connectionActive) {
            attemptReconnect();
          }
        });
      } catch (error) {
        console.error("[II] Error creating WebSocket connection:", error);
        attemptReconnect();
      }
    }
    
    function attemptReconnect() {
      if (!connectionActive) return;
      
      reconnectAttempts++;
      if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
        console.log(`[II] Attempting reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(connectToElevenLabs, 2000 * reconnectAttempts);
      } else {
        console.error("[II] Maximum reconnect attempts reached. Giving up.");
        connectionActive = false;
        connection.close();
      }
    }
    
    function checkConnection() {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        // Posíláme ping na server, abychom ověřili spojení
        try {
          elevenLabsWs.send(JSON.stringify({ type: 'ping' }));
          console.log("[II] Sent manual ping to check connection");
          connectionWatchdog = setTimeout(checkConnection, 30000);
        } catch (error) {
          console.error("[II] Error sending ping, connection might be dead:", error);
          attemptReconnect();
        }
      } else {
        console.log("[II] Connection check failed - connection not open");
        attemptReconnect();
      }
    }
    
    // Inicializace spojení
    connectToElevenLabs();

    const handleElevenLabsMessage = (message, connection) => {
      switch (message.type) {
        case "conversation_initiation_metadata":
          console.info("[II] Received conversation initiation metadata.");
          break;
        case "audio":
          if (message.audio_event?.audio_base_64) {
            const audioData = {
              event: "media",
              streamSid,
              media: {
                payload: message.audio_event.audio_base_64,
              },
            };
            connection.send(JSON.stringify(audioData));
          }
          break;
        case "interruption":
          connection.send(JSON.stringify({ event: "clear", streamSid }));
          break;
        case "ping":
          if (message.ping_event?.event_id) {
            const pongResponse = {
              type: "pong",
              event_id: message.ping_event.event_id,
            };
            elevenLabsWs.send(JSON.stringify(pongResponse));
          }
          break;
      }
    };

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started with ID: ${streamSid}`);
            break;
          case "media":
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;
          case "stop":
            connectionActive = false;
            clearTimeout(connectionWatchdog);
            if (elevenLabsWs) elevenLabsWs.close();
            break;
          default:
            console.log(`[Twilio] Received unhandled event: ${data.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    connection.on("close", () => {
      connectionActive = false;
      clearTimeout(connectionWatchdog);
      if (elevenLabsWs) elevenLabsWs.close();
      console.log("[Twilio] Client disconnected");
    });

    connection.on("error", (error) => {
      console.error("[Twilio] WebSocket error:", error);
      connectionActive = false;
      clearTimeout(connectionWatchdog);
      if (elevenLabsWs) elevenLabsWs.close();
    });
  });
});

// Route to initiate an outbound call
fastify.post("/make-outbound-call", async (request, reply) => {
  const { to } = request.body; // Destination phone number

  if (!to) {
    return reply.status(400).send({ error: "Destination phone number is required" });
  }

  try {
    // Použití PUBLIC_URL z .env pro callback URL
    const callbackUrl = `${serverUrl || `https://${request.headers.host}`}/call-status`;
    console.log(`[Twilio] Setting statusCallback URL: ${callbackUrl}`);
    
    const call = await twilioClient.calls.create({
      url: `${serverUrl || `https://${request.headers.host}`}/incoming-call-eleven`, // Webhook pro obsluhu hovoru
      to: to,
      from: TWILIO_PHONE_NUMBER,
      statusCallback: callbackUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    console.log(`[Twilio] Outbound call initiated: ${call.sid} to ${to}`);
    reply.send({ 
      message: "Call initiated", 
      callSid: call.sid, 
      statusCallbackUrl: callbackUrl 
    });
  } catch (error) {
    console.error("[Twilio] Error initiating call:", error);
    reply.status(500).send({ error: "Failed to initiate call", details: error.message });
  }
});

// Přidání vylepšeného rozhraní pro sledování hovorů
fastify.get("/calls", async (_, reply) => {
  reply.type('text/html').send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Sledování hovorů Twilio</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; }
        h1, h2 { color: #333; }
        .controls { margin: 20px 0; display: flex; align-items: center; flex-wrap: wrap; }
        .controls label { margin-right: 8px; font-weight: bold; }
        input, button, textarea { padding: 8px; margin-right: 10px; margin-bottom: 5px; }
        textarea { width: 100%; height: 80px; }
        #callStatus { margin-top: 20px; border: 1px solid #ddd; padding: 15px; border-radius: 5px; }
        #callHistory { margin-top: 20px; }
        .call-record { padding: 10px; margin: 5px 0; background: #f5f5f5; border-radius: 3px; }
        .settings-panel { margin-top: 15px; padding: 15px; border: 1px solid #eee; border-radius: 5px; }
        .status-badge {
          display: inline-block;
          padding: 3px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: bold;
          color: white;
        }
        .status-initiated { background-color: #f0ad4e; }
        .status-ringing { background-color: #5bc0de; }
        .status-inprogress { background-color: #5cb85c; }
        .status-completed { background-color: #0275d8; }
        .status-failed { background-color: #d9534f; }
        .status-busy { background-color: #d9534f; }
        .status-noanswer { background-color: #d9534f; }
        .server-info { margin-bottom: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 5px; }
        
        /* Styly pro tabulku výsledků */
        .results-table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        .results-table th { background-color: #f0f0f0; padding: 10px; text-align: left; border: 1px solid #ddd; }
        .results-table td { padding: 8px; border: 1px solid #ddd; }
        .results-table tr:nth-child(even) { background-color: #f9f9f9; }
        .export-button { margin-top: 10px; background-color: #4CAF50; color: white; border: none; 
                        padding: 10px 15px; border-radius: 4px; cursor: pointer; }
        .export-button:hover { background-color: #45a049; }
        .refresh-button { background-color: #2196F3; color: white; border: none; 
                         padding: 10px 15px; border-radius: 4px; cursor: pointer; margin-right: 10px; }
        .refresh-button:hover { background-color: #0b7dda; }
        .clear-button { background-color: #f44336; color: white; border: none; 
                       padding: 10px 15px; border-radius: 4px; cursor: pointer; }
        .clear-button:hover { background-color: #d32f2f; }
        .table-controls { margin-top: 20px; display: flex; }
      </style>
    </head>
    <body>
      <h1>Sledování hovorů Twilio</h1>
      
      <div class="server-info">
        <strong>Server URL:</strong> ${serverUrl || 'Není nastaveno v .env souboru'}
      </div>
      
      <div class="settings-panel">
        <h2>Nastavení</h2>
        <div class="controls">
          <label>Automatická aktualizace:</label>
          <input type="checkbox" id="autoRefresh" checked>
          <span style="margin-left: 5px;">každých</span>
          <input type="number" id="refreshInterval" value="500" min="200" max="10000" style="width: 70px;">
          <span>ms</span>
        </div>
      </div>
      
      <div class="controls">
        <div style="width: 100%;">
          <label for="phoneNumbers">Telefonní čísla (jedno na řádek):</label>
          <textarea id="phoneNumbers" placeholder="+420123456789
+420987654321"></textarea>
        </div>
      </div>
      
      <div class="controls">
        <button onclick="callNextNumber()" style="background: #5cb85c; color: white; font-weight: bold; padding: 10px 15px;">
          Volat postupně
        </button>
        <button onclick="stopSequence()" style="background: #d9534f; color: white; margin-left: 10px; padding: 10px 15px;">
          Zastavit volání
        </button>
      </div>
      
      <div id="callStatus">Zde se zobrazí informace o aktuálním hovoru</div>
      
      <div id="callHistory">
        <h2>Historie hovorů</h2>
        <div id="callRecords"></div>
      </div>
      
      <div id="results-section">
        <h2>Přehled výsledků volání</h2>
        
        <div class="table-controls">
          <button onclick="refreshCallResults()" class="refresh-button">Obnovit výsledky</button>
          <button onclick="exportCSV()" class="export-button">Stáhnout CSV</button>
          <button onclick="clearTable()" class="clear-button">Vymazat tabulku</button>
        </div>
        
        <table class="results-table" id="results-table">
          <thead>
            <tr>
              <th>Čas</th>
              <th>ID hovoru</th>
              <th>Z čísla</th>
              <th>Na číslo</th>
              <th>Stav</th>
              <th>Přijato</th>
              <th>Délka (s)</th>
            </tr>
          </thead>
          <tbody id="results-body">
            <tr>
              <td colspan="7" style="text-align: center;">Načítání výsledků...</td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <script>
        // Globální proměnné
        let lastCallSid = '';
        const serverBaseUrl = "${serverUrl || ''}";
        let isSequenceRunning = false;
        let phoneNumberQueue = [];
        let autoRefreshInterval = null;
        
        // Po načtení stránky
        window.onload = function() {
          // Kontrola, zda je nastavena URL serveru
          if (!serverBaseUrl) {
            alert('Varování: URL serveru není nastavena v .env souboru (PUBLIC_URL). Aplikace nemusí fungovat správně.');
          }
          
          // Spuštění automatické aktualizace
          toggleAutoRefresh();
          
          // Přidání posluchače události pro checkbox
          document.getElementById('autoRefresh').addEventListener('change', toggleAutoRefresh);
          document.getElementById('refreshInterval').addEventListener('change', toggleAutoRefresh);
          
          // Načtení výsledků volání
          refreshCallResults();
        };
        
        // Funkce pro načtení výsledků volání
        async function refreshCallResults() {
          if (!serverBaseUrl) {
            document.getElementById('results-body').innerHTML = 
              '<tr><td colspan="7" style="text-align: center;">Nejprve nastavte URL serveru</td></tr>';
            return;
          }
          
          try {
            const response = await fetch(\`\${serverBaseUrl}/call-history\`);
            
            if (!response.ok) {
              throw new Error('Chyba serveru: ' + response.status);
            }
            
            const data = await response.json();
            
            if (!data.calls || data.calls.length === 0) {
              document.getElementById('results-body').innerHTML = 
                '<tr><td colspan="7" style="text-align: center;">Žádná data k zobrazení</td></tr>';
              return;
            }
            
            // Zobrazení dat v tabulce (nejnovější nahoře)
            const tableRows = data.calls.reverse().map(call => {
              // Formátování data
              const timestamp = new Date(call.timestamp).toLocaleString();
              
              // Zobrazení stavu
              let statusText = '';
              switch(call.status) {
                case 'in-progress': statusText = '🟢 Aktivní'; break;
                case 'completed': statusText = '🔵 Ukončený'; break;
                case 'busy': statusText = '⛔ Obsazeno'; break;
                case 'no-answer': statusText = '❌ Bez odpovědi'; break;
                case 'failed': statusText = '⚠️ Selhal'; break;
                default: statusText = call.status;
              }
              
              return \`
                <tr>
                  <td>\${timestamp}</td>
                  <td>\${call.callSid}</td>
                  <td>\${call.from}</td>
                  <td>\${call.to}</td>
                  <td>\${statusText}</td>
                  <td>\${call.answered}</td>
                  <td>\${call.duration}</td>
                </tr>
              \`;
            }).join('');
            
            document.getElementById('results-body').innerHTML = tableRows;
            
          } catch (error) {
            console.error('Chyba při načítání výsledků:', error);
            document.getElementById('results-body').innerHTML = 
              \`<tr><td colspan="7" style="text-align: center;">Chyba při načítání: \${error.message}</td></tr>\`;
          }
        }
        
        // Funkce pro export CSV
        function exportCSV() {
          if (!serverBaseUrl) {
            alert('Nejprve nastavte URL serveru');
            return;
          }
          
          // Otevření CSV souboru v novém okně/záložce
          window.open(\`\${serverBaseUrl}/call-history.csv\`, '_blank');
        }
        
        // Funkce pro vymazání tabulky výsledků (zatím jen placeholder)
        function clearTable() {
          if (confirm('Opravdu chcete vymazat všechny záznamy? Tuto akci nelze vrátit.')) {
            // Zde by byl API požadavek na vymazání dat
            alert('Tato funkce zatím není implementována.');
          }
        }
        
        // Zapnutí/vypnutí automatické aktualizace
        function toggleAutoRefresh() {
          const isEnabled = document.getElementById('autoRefresh').checked;
          const interval = parseInt(document.getElementById('refreshInterval').value) || 500;
          
          // Zastavit existující interval
          if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
          }
          
          // Nastavit nový interval, pokud je povoleno
          if (isEnabled && lastCallSid) {
            autoRefreshInterval = setInterval(() => {
              checkCallById(lastCallSid);
            }, interval);
          }
        }
        
        // Funkce pro vytočení dalšího čísla v řadě
        function callNextNumber() {
          // Kontrola dostupnosti serveru
          if (!serverBaseUrl) {
            alert('Chyba: URL serveru není nastavena. Zkontrolujte proměnnou PUBLIC_URL v .env souboru.');
            return;
          }
          
          // Nejprve načteme všechna čísla, pokud jsme právě začali
          if (!isSequenceRunning) {
            const numbersText = document.getElementById('phoneNumbers').value.trim();
            if (!numbersText) {
              alert('Zadejte alespoň jedno telefonní číslo');
              return;
            }
            
            // Rozdělit na jednotlivá čísla (odstraní prázdné řádky)
            phoneNumberQueue = numbersText.split('\\n')
              .map(n => n.trim())
              .filter(n => n.length > 0);
              
            if (phoneNumberQueue.length === 0) {
              alert('Žádná platná telefonní čísla');
              return;
            }
            
            isSequenceRunning = true;
          }
          
          // Kontrola, zda máme ještě čísla k volání
          if (phoneNumberQueue.length === 0) {
            alert('Všechna čísla byla vytočena');
            isSequenceRunning = false;
            return;
          }
          
          // Vytočit další číslo
          const nextNumber = phoneNumberQueue.shift();
          makeCall(nextNumber);
          
          // Aktualizovat seznam zbývajících čísel
          document.getElementById('phoneNumbers').value = [nextNumber + ' (právě voláno)', ...phoneNumberQueue].join('\\n');
        }
        
        // Zastavení sekvenčního volání
        function stopSequence() {
          isSequenceRunning = false;
          phoneNumberQueue = [];
          alert('Sekvenční volání bylo zastaveno');
        }
        
        // Vytočení konkrétního čísla
        async function makeCall(phoneNumber) {
          if (!phoneNumber) return alert('Zadejte telefonní číslo');
          if (!serverBaseUrl) return alert('Chyba: URL serveru není nastavena');
          
          try {
            const response = await fetch(serverBaseUrl + '/make-outbound-call', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to: phoneNumber })
            });
            
            if (!response.ok) {
              throw new Error('Chyba serveru: ' + response.status);
            }
            
            const data = await response.json();
            
            // Uložíme CallSid pro pozdější automatické použití
            lastCallSid = data.callSid;
            
            document.getElementById('callStatus').innerHTML = 
              \`<h3>Hovor na: \${phoneNumber}</h3>
               <p>Stav: <span class="status-badge status-initiated">Zahájeno</span></p>
               <p>CallSID: \${data.callSid}</p>
               <p>Callback URL: \${data.statusCallbackUrl}</p>\`;
               
            // Přidáme záznam do historie
            addCallRecord(data.callSid, phoneNumber);
            
            // Spustit automatickou aktualizaci
            toggleAutoRefresh();
            
          } catch (error) {
            console.error('Chyba:', error);
            alert('Chyba: ' + error.message);
          }
        }
        
        // Funkce pro kontrolu konkrétního hovoru
        async function checkCallById(callSid) {
          if (!callSid || !serverBaseUrl) return;
          
          try {
            const response = await fetch(\`\${serverBaseUrl}/call-status/\${callSid}\`);
            
            if (!response.ok) {
              throw new Error('Chyba serveru: ' + response.status);
            }
            
            const data = await response.json();
            let statusText = '';
            let statusClass = '';
            
            switch(data.status) {
              case 'in-progress': 
                statusText = '🟢 Aktivní'; 
                statusClass = 'status-inprogress';
                break;
              case 'completed': 
                statusText = '🔵 Ukončený'; 
                statusClass = 'status-completed';
                
                // Pokud je sekvence aktivní a hovor skončil, zavolat další číslo po krátké pauze
                if (isSequenceRunning && phoneNumberQueue.length > 0) {
                  setTimeout(callNextNumber, 2000);
                }
                break;
              case 'busy': 
                statusText = '⛔ Obsazeno'; 
                statusClass = 'status-busy';
                
                // Pokud je sekvence aktivní a hovor byl obsazený, zavolat další číslo po krátké pauze
                if (isSequenceRunning && phoneNumberQueue.length > 0) {
                  setTimeout(callNextNumber, 2000);
                }
                break;
              case 'no-answer': 
                statusText = '❌ Bez odpovědi'; 
                statusClass = 'status-noanswer';
                
                // Pokud je sekvence aktivní a nikdo to nezvedl, zavolat další číslo po krátké pauze
                if (isSequenceRunning && phoneNumberQueue.length > 0) {
                  setTimeout(callNextNumber, 2000);
                }
                break;
              case 'failed': 
                statusText = '⚠️ Selhal'; 
                statusClass = 'status-failed';
                
                // Pokud je sekvence aktivní a hovor selhal, zavolat další číslo po krátké pauze
                if (isSequenceRunning && phoneNumberQueue.length > 0) {
                  setTimeout(callNextNumber, 2000);
                }
                break;
              default: 
                statusText = data.status;
            }
            
            document.getElementById('callStatus').innerHTML = 
              \`<h3>Hovor: \${data.to}</h3>
               <p>Stav: <span class="status-badge \${statusClass}">\${statusText}</span></p>
               <p>CallSID: \${data.callSid}</p>
               <p>Z čísla: \${data.from}</p>
               <p>Na číslo: \${data.to}</p>
               <p>Začátek: \${data.startTime || 'N/A'}</p>
               <p>Konec: \${data.endTime || 'N/A'}</p>
               <p>Délka: \${data.duration ? data.duration + ' sekund' : 'N/A'}</p>\`;
               
            // Aktualizace záznamu v historii
            updateCallRecord(data.callSid, data.status, data.duration);
            
          } catch (error) {
            console.error('Chyba při získávání stavu hovoru:', error);
          }
        }
        
        // Přidání záznamu do historie hovorů
        function addCallRecord(callSid, phoneNumber) {
          const recordsDiv = document.getElementById('callRecords');
          const record = document.createElement('div');
          record.className = 'call-record';
          record.id = 'record-' + callSid;
          record.innerHTML = \`
            <strong>Hovor na: \${phoneNumber}</strong> 
            <span class="status-badge status-initiated">Zahájeno</span>
            <button onclick="checkCallById('\${callSid}')">Aktualizovat</button>
          \`;
          recordsDiv.prepend(record);
        }
        
        // Aktualizace záznamu v historii
        function updateCallRecord(callSid, status, duration) {
          const record = document.getElementById('record-' + callSid);
          if (!record) return;
          
          let statusText = '';
          let statusClass = '';
          
          switch(status) {
            case 'in-progress': 
              statusText = '🟢 Aktivní'; 
              statusClass = 'status-inprogress';
              break;
            case 'completed': 
              statusText = '🔵 Ukončen (' + (duration || '?') + 's)'; 
              statusClass = 'status-completed';
              break;
            case 'busy': 
              statusText = '⛔ Obsazeno'; 
              statusClass = 'status-busy';
              break;
            case 'no-answer': 
              statusText = '❌ Bez odpovědi'; 
              statusClass = 'status-noanswer';
              break;
            case 'failed': 
              statusText = '⚠️ Selhal'; 
              statusClass = 'status-failed';
              break;
            default: 
              statusText = status;
          }
          
          const statusSpan = record.querySelector('.status-badge');
          if (statusSpan) {
            statusSpan.textContent = statusText;
            statusSpan.className = 'status-badge ' + statusClass;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Endpoint pro získání historie hovorů ve formátu CSV
fastify.get("/call-history.csv", async (_, reply) => {
  try {
    const csvData = fs.readFileSync(CSV_FILE_PATH, 'utf8');
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename=call_history.csv');
    reply.send(csvData);
  } catch (error) {
    console.error('[Server] Error serving CSV file:', error);
    reply.status(500).send({ error: 'Failed to get call history' });
  }
});

// Endpoint pro získání historie hovorů ve formátu JSON
fastify.get("/call-history", async (_, reply) => {
  try {
    const csvData = fs.readFileSync(CSV_FILE_PATH, 'utf8');
    const lines = csvData.trim().split('\n');
    const headers = lines[0].split(',');
    
    const callHistory = [];
    for (let i = 1; i < lines.length; i++) {
      // Správně rozdělíme CSV řádky, aby se zachovaly uvozovky
      const currentLine = lines[i].trim();
      if (!currentLine) continue;
      
      // Jednoduchý parser CSV s uvozovkami
      const values = [];
      let inQuotes = false;
      let currentValue = '';
      
      for (let j = 0; j < currentLine.length; j++) {
        const char = currentLine[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(currentValue);
          currentValue = '';
        } else {
          currentValue += char;
        }
      }
      values.push(currentValue); // Přidáme poslední hodnotu
      
      // Vytvoříme objekt s daty hovoru
      const call = {};
      for (let j = 0; j < headers.length; j++) {
        call[headers[j]] = values[j] || '';
      }
      callHistory.push(call);
    }
    
    reply.send({ calls: callHistory });
  } catch (error) {
    console.error('[Server] Error serving call history:', error);
    reply.status(500).send({ error: 'Failed to get call history' });
  }
});

// Endpoint pro vymazání historie hovorů
fastify.delete("/call-history", async (_, reply) => {
  try {
    // Ponecháme hlavičku a vymažeme obsah
    fs.writeFileSync(CSV_FILE_PATH, CSV_HEADER);
    console.log(`[Server] Call history cleared`);
    reply.send({ success: true, message: 'Call history cleared' });
  } catch (error) {
    console.error('[Server] Error clearing call history:', error);
    reply.status(500).send({ error: 'Failed to clear call history' });
  }
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
