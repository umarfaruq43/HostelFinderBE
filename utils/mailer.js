function parseSender(fromStr, fallbackEmail) {
    if (!fromStr) return { name: "Hostel Finder", email: fallbackEmail };
    const str = fromStr.trim();
    const ltIdx = str.indexOf("<");
    const gtIdx = str.indexOf(">");
    if (ltIdx !== -1 && gtIdx > ltIdx) {
        const namePart = str.slice(0, ltIdx).replace(/["']/g, "").trim();
        const emailPart = str.slice(ltIdx + 1, gtIdx).trim();
        return {
            name: namePart || "Hostel Finder",
            email: emailPart,
        };
    }
    return { name: "Hostel Finder", email: str };
}

async function sendMail({ to, subject, text, html }) {
    // 1. If Brevo API Key is configured, send via Brevo REST API (HTTPS / Port 443)
    // This completely bypasses SMTP port 25/465/587 blocks on cloud providers like Render.
    if (process.env.BREVO_API_KEY) {
        const sender = parseSender(
            process.env.MAIL_FROM || process.env.SMTP_USER,
            "noreply@hostelfinder.com",
        );

        const payload = {
            sender,
            to: [{ email: to }],
            subject,
            textContent: text,
        };
        if (html) {
            payload.htmlContent = html;
        }

        const response = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                accept: "application/json",
                "api-key": process.env.BREVO_API_KEY,
                "content-type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(
                errBody.message ||
                    `Brevo API error: ${response.status} ${response.statusText}`,
            );
        }
        return;
    }

    // 2. If SMTP_HOST is configured, send via SMTP (Nodemailer)
    if (process.env.SMTP_HOST) {
        const nodemailer = require("nodemailer");

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined,
            connectionTimeout: 8000,
            greetingTimeout: 8000,
            socketTimeout: 10000,
        });

        await transporter.sendMail({
            from: process.env.MAIL_FROM || process.env.SMTP_USER,
            to,
            subject,
            text,
            html,
        });
        return;
    }

    // 3. Fallback for local development if neither is configured
    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "Email service is not configured (missing BREVO_API_KEY or SMTP_HOST)",
        );
    }

    console.log(`\n[DEV MAIL] To: ${to}\nSubject: ${subject}\n${text}\n`);
}

module.exports = { sendMail };
