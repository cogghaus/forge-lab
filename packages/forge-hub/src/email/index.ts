import { Resend } from 'resend';

export interface EmailService {
  sendEmailVerification(params: { to: string; verifyUrl: string; currentEmail: string }): Promise<void>;
}

export function createEmailService(apiKey: string): EmailService {
  const resend = new Resend(apiKey);
  return {
    async sendEmailVerification({ to, verifyUrl, currentEmail }) {
      await resend.emails.send({
        // Configurable: an open-core project must not hardcode the maintainer's
        // own sending domain, and a deployer needs their own verified sender.
        from: process.env.FORGE_HUB_MAIL_FROM ?? 'Forge Lab <noreply@example.com>',
        to,
        subject: 'Confirm your email change',
        html: `
          <div style="font-family:monospace;max-width:480px;margin:0 auto;padding:24px;background:#09090B;color:#F5F0EB">
            <h2 style="color:#FF6B2B;margin-bottom:16px">Confirm Email Change</h2>
            <p>You requested to change your Forge Lab account email.</p>
            <p><strong>Current:</strong> ${currentEmail}<br><strong>New:</strong> ${to}</p>
            <p style="margin:24px 0">
              <a href="${verifyUrl}" style="background:#FF6B2B;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px">
                Confirm Email Change
              </a>
            </p>
            <p style="color:rgba(245,240,235,0.4);font-size:11px">
              Link expires in 24 hours. If you didn't request this, ignore this email.
            </p>
          </div>
        `,
      });
    },
  };
}
