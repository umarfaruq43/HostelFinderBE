async function sendMail({ to, subject, text }) {
    if (!process.env.SMTP_HOST) {
        if (process.env.NODE_ENV === "production") {
            throw new Error("SMTP is not configured");
        }
        console.log(`\n[DEV MAIL] To: ${to}\nSubject: ${subject}\n${text}\n`);
        return;
    }

    const nodemailer = require("nodemailer");

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
        connectionTimeout: 8000, // Fail after 8s if network cannot connect
        greetingTimeout: 8000,
        socketTimeout: 10000,
    });

    await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to,
        subject,
        text,
    });
}

module.exports = { sendMail };
