const fs = require("fs");
const { google } = require("googleapis");

const lines = fs.readFileSync(".env.local", "utf8").split("\n");
const getEnv = (key) => {
    const line = lines.find(l => l.startsWith(key + "="));
    return line ? line.substring(key.length + 1).trim() : "";
};

const clientId = getEnv("GOOGLE_CLIENT_ID");
const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
const refreshToken = getEnv("GOOGLE_REFRESH_TOKEN");

console.log("Client ID:", clientId.substring(0, 15) + "...");
console.log("Client Secret:", clientSecret.substring(0, 8) + "...");
console.log("Refresh Token:", refreshToken.substring(0, 15) + "...");

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "http://localhost:3000/api/auth/google/callback");
oauth2.setCredentials({ refresh_token: refreshToken });

async function testCalendar() {
    console.log("\n--- Testing Calendar API ---");
    try {
        const cal = google.calendar({ version: "v3", auth: oauth2 });
        const res = await cal.events.list({
            calendarId: "primary",
            timeMin: new Date().toISOString(),
            maxResults: 3,
            singleEvents: true,
            orderBy: "startTime",
        });
        console.log("✅ Calendar works! Events:", res.data.items?.length ?? 0);
    } catch (err) {
        console.error("❌ Calendar error:", err.message);
        if (err.response) {
            console.error("   Status:", err.response.status);
            console.error("   Data:", JSON.stringify(err.response.data));
        }
    }
}

async function testGmail() {
    console.log("\n--- Testing Gmail API ---");
    try {
        const gmail = google.gmail({ version: "v1", auth: oauth2 });
        const res = await gmail.users.messages.list({
            userId: "me",
            q: "is:unread in:inbox",
            maxResults: 3,
        });
        console.log("✅ Gmail works! Messages:", res.data.messages?.length ?? 0);
    } catch (err) {
        console.error("❌ Gmail error:", err.message);
        if (err.response) {
            console.error("   Status:", err.response.status);
            console.error("   Data:", JSON.stringify(err.response.data));
        }
    }
}

testCalendar().then(testGmail);
