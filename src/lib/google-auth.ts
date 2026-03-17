import { google } from "googleapis";

// Google OAuth2 client — reused across Calendar and Gmail services.
// Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in env.
const SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
];

let oauth2Client: InstanceType<typeof google.auth.OAuth2> | null = null;

export function getOAuth2Client() {
    if (oauth2Client) return oauth2Client;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
        throw new Error(
            "Missing Google API credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN."
        );
    }

    oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        "http://localhost:3000/api/auth/google/callback"
    );

    oauth2Client.setCredentials({ refresh_token: refreshToken });

    return oauth2Client;
}

export { SCOPES };
