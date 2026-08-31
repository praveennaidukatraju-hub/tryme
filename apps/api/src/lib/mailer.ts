import { Resend } from 'resend';

let _client: Resend | null = null;
function getClient(apiKey: string): Resend {
  if (!_client) _client = new Resend(apiKey);
  return _client;
}

function verifyHtml(link: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;text-align:center;">
    <h1 style="font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:8px;">Verify your email</h1>
    <p style="font-size:14px;color:#555;margin-bottom:32px;">Click the button below to verify your Tryme account. This link expires in 24 hours.</p>
    <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">Verify Email</a>
    <p style="font-size:12px;color:#999;margin-top:32px;">If you didn't create an account, you can safely ignore this email.</p>
  </div>
</body>
</html>`;
}

function welcomeHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;">
    <h1 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 20px;">Thank You for Signing Up with AI Vastra 🎉</h1>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">Hi,</p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">Thank you for signing up with AI Vastra! We're excited to help you transform your fashion business with our AI-powered solutions:</p>
    <ul style="font-size:14px;color:#555;margin:0 0 16px;padding-left:20px;">
      <li style="margin-bottom:8px;"><strong style="color:#1a1a1a;">AI Virtual Try-On</strong> – Let customers virtually try your products before buying.</li>
      <li><strong style="color:#1a1a1a;">AI Catalogue Photoshoot</strong> – Create professional fashion catalogue images without traditional photoshoots.</li>
    </ul>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">We look forward to helping you save time, reduce photoshoot costs, and create a better shopping experience for your customers.</p>
    <p style="font-size:14px;color:#555;margin:0 0 4px;">For any support, please contact us:</p>
    <p style="font-size:14px;color:#555;margin:0 0 4px;">📧 <a href="mailto:support@tryme.com" style="color:#1a1a1a;">support@tryme.com</a></p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">📱 WhatsApp: +91 7729883692</p>
    <p style="font-size:14px;color:#555;margin:0;">Best regards,<br/>Team AI Vastra</p>
  </div>
</body>
</html>`;
}

function resetHtml(link: string): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;text-align:center;">
    <h1 style="font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:8px;">Reset your password</h1>
    <p style="font-size:14px;color:#555;margin-bottom:32px;">Click the button below to reset your Tryme password. This link expires in 1 hour.</p>
    <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">Reset Password</a>
    <p style="font-size:12px;color:#999;margin-top:32px;">If you didn't request a password reset, you can safely ignore this email.</p>
  </div>
</body>
</html>`;
}

function receiptHtml(r: {
  planName: string;
  credits: number;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  paidAt: Date;
}): string {
  const fmt = (paise: number) =>
    `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const fmtDate = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#1a1a1a;padding:28px 32px;text-align:center;">
      <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0;">Tryme</h1>
      <p style="color:rgba(255,255,255,0.6);font-size:13px;margin:6px 0 0;">Payment Receipt</p>
    </div>
    <div style="padding:32px;">
      <p style="font-size:14px;color:#555;margin:0 0 24px;">Thank you for your purchase! Your credits have been added to your account.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px;">
        <tr style="background:#f9f9f9;">
          <th style="text-align:left;padding:10px 12px;color:#666;font-weight:600;border-bottom:1px solid #eee;">Description</th>
          <th style="text-align:right;padding:10px 12px;color:#666;font-weight:600;border-bottom:1px solid #eee;">Amount</th>
        </tr>
        <tr>
          <td style="padding:12px;color:#1a1a1a;">${r.planName} — ${r.credits.toLocaleString('en-IN')} Credits</td>
          <td style="padding:12px;color:#1a1a1a;text-align:right;">${fmt(r.basePaise)}</td>
        </tr>
        <tr style="background:#fafafa;">
          <td style="padding:10px 12px;color:#666;font-size:13px;">GST (18%)</td>
          <td style="padding:10px 12px;color:#666;font-size:13px;text-align:right;">${fmt(r.gstPaise)}</td>
        </tr>
        <tr style="border-top:2px solid #1a1a1a;">
          <td style="padding:12px;color:#1a1a1a;font-weight:700;">Total Paid</td>
          <td style="padding:12px;color:#1a1a1a;font-weight:700;text-align:right;">${fmt(r.totalPaise)}</td>
        </tr>
      </table>
      <div style="background:#f9f9f9;border-radius:8px;padding:16px;font-size:13px;color:#555;line-height:1.8;">
        <div><span style="color:#999;">Date:</span> <strong style="color:#1a1a1a;">${fmtDate(r.paidAt)}</strong></div>
        <div><span style="color:#999;">Order ID:</span> <strong style="color:#1a1a1a;">${r.razorpayOrderId}</strong></div>
        <div><span style="color:#999;">Payment ID:</span> <strong style="color:#1a1a1a;">${r.razorpayPaymentId}</strong></div>
      </div>
      <p style="font-size:12px;color:#999;margin:24px 0 0;text-align:center;">If you have any questions, reply to this email or contact support.</p>
    </div>
  </div>
</body>
</html>`;
}

async function send(
  apiKey: string,
  payload: Parameters<Resend['emails']['send']>[0],
): Promise<void> {
  const { error } = await getClient(apiKey).emails.send(payload);
  if (error) throw new Error(`Resend error: ${error.name} — ${error.message}`);
}

export async function sendVerificationEmail(
  apiKey: string,
  from: string,
  webUrl: string,
  to: string,
  token: string,
): Promise<void> {
  const link = `${webUrl}/verify-email/confirm?token=${token}`;
  await send(apiKey, { from, to, subject: 'Verify your Tryme account', html: verifyHtml(link) });
}

export async function sendWelcomeEmail(apiKey: string, from: string, to: string): Promise<void> {
  await send(apiKey, {
    from,
    to,
    subject: 'Thank You for Signing Up with AI Vastra',
    html: welcomeHtml(),
  });
}

export async function sendPaymentReceiptEmail(
  apiKey: string,
  from: string,
  to: string,
  receipt: {
    planName: string;
    credits: number;
    basePaise: number;
    gstPaise: number;
    totalPaise: number;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    paidAt: Date;
  },
  attachments?: Array<{ filename: string; content: Buffer }>,
): Promise<void> {
  const totalRupees = (receipt.totalPaise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
  });
  await send(apiKey, {
    from,
    to,
    subject: `Payment confirmed — ${receipt.credits.toLocaleString('en-IN')} credits (₹${totalRupees})`,
    html: receiptHtml(receipt),
    attachments,
  });
}

export async function sendPasswordResetEmail(
  apiKey: string,
  from: string,
  webUrl: string,
  to: string,
  token: string,
): Promise<void> {
  const link = `${webUrl}/reset-password?token=${token}`;
  await send(apiKey, { from, to, subject: 'Reset your Tryme password', html: resetHtml(link) });
}

function userLowCreditsHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;">
    <h1 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 20px;">Your AI Vastra Credits Are Running Low 🚨</h1>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">Hi,</p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">Your AI Vastra credits are running low.</p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">Keep creating amazing AI catalogue photoshoots and offering Virtual Try-On to your customers without interruption.</p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">✨ Top up your credits today and keep your fashion store running smoothly.</p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">Need help choosing the right package? Our team is happy to assist.</p>
    <p style="font-size:14px;color:#555;margin:0 0 4px;">📧 <a href="mailto:support@tryme.com" style="color:#1a1a1a;">support@tryme.com</a></p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">📱 WhatsApp: +91 7729883692</p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">Keep creating. Keep selling with AI Vastra! 🚀</p>
    <p style="font-size:14px;color:#555;margin:0;">Best regards,<br/>Team AI Vastra</p>
  </div>
</body>
</html>`;
}

export async function sendUserLowCreditsEmail(
  apiKey: string,
  from: string,
  to: string,
): Promise<void> {
  await send(apiKey, {
    from,
    to,
    subject: 'Your AI Vastra Credits Are Running Low',
    html: userLowCreditsHtml(),
  });
}

function reportReceivedHtml(): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;">
    <h1 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 20px;">Thank you for reporting the issue 🙏</h1>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">We've received your report and our team will review the result. Your feedback helps us improve AI Vastra and deliver better results.</p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;">If you need any further assistance, please contact our support team.</p>
    <p style="font-size:14px;color:#555;margin:0 0 4px;">📧 <a href="mailto:support@tryme.com" style="color:#1a1a1a;">support@tryme.com</a></p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">📱 WhatsApp: +91 7729883692</p>
    <p style="font-size:14px;color:#555;margin:0 0 24px;">Keep creating. Keep selling with AI Vastra! 🚀</p>
    <p style="font-size:14px;color:#555;margin:0;">Best regards,<br/>Team AI Vastra</p>
  </div>
</body>
</html>`;
}

export async function sendReportReceivedEmail(
  apiKey: string,
  from: string,
  to: string,
): Promise<void> {
  await send(apiKey, {
    from,
    to,
    subject: 'Report notification',
    html: reportReceivedHtml(),
  });
}

function lowCreditsHtml(p: {
  appUrl: string;
  level: 'warning' | 'critical' | 'empty';
  balance: number;
  tryOnsRemaining: number;
  daysRemaining: number | null;
}): string {
  const accent = p.level === 'warning' ? '#b26a00' : '#b42318';
  const heading =
    p.level === 'empty'
      ? "You're out of try-on credits"
      : p.level === 'critical'
        ? 'Your try-on credits run out in about a day'
        : 'Your try-on credits are running low';

  // Only stated when there is a real burn rate behind it. Saying "about 0 days"
  // because nothing has been generated recently would be wrong and alarming.
  const runwayLine =
    p.daysRemaining != null && p.level !== 'empty'
      ? `<p style="font-size:14px;color:#555;margin:0 0 8px;">At your current rate that's about <strong>${Math.max(1, Math.round(p.daysRemaining))} more day${Math.round(p.daysRemaining) === 1 ? '' : 's'}</strong>.</p>`
      : '';

  const body =
    p.level === 'empty'
      ? 'Try-on has stopped for shoppers on your store. Adding credits turns it straight back on — nothing else needs reconfiguring.'
      : 'When your balance reaches zero, the try-on button stops working for shoppers on your store. Topping up now avoids that.';

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:${accent};padding:20px 32px;">
      <h1 style="color:#fff;font-size:18px;font-weight:700;margin:0;">${heading}</h1>
    </div>
    <div style="padding:32px;">
      <p style="font-size:14px;color:#555;margin:0 0 8px;">
        Your store has <strong style="color:#1a1a1a;">${p.balance.toLocaleString()} credits</strong> left —
        about <strong style="color:#1a1a1a;">${p.tryOnsRemaining.toLocaleString()} try-ons</strong>.
      </p>
      ${runwayLine}
      <p style="font-size:14px;color:#555;margin:16px 0 28px;">${body}</p>
      <a href="${p.appUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">Add credits</a>
      <p style="font-size:12px;color:#999;margin:32px 0 0;">Credits never expire — anything you buy stays on your account until you use it.</p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendLowCreditsEmail(
  apiKey: string,
  from: string,
  to: string,
  params: {
    shopDomain: string;
    appUrl: string;
    level: 'warning' | 'critical' | 'empty';
    balance: number;
    tryOnsRemaining: number;
    daysRemaining: number | null;
  },
): Promise<void> {
  const subject =
    params.level === 'empty'
      ? `${params.shopDomain} is out of try-on credits`
      : params.level === 'critical'
        ? `${params.shopDomain}: try-on credits run out in about a day`
        : `${params.shopDomain}: try-on credits running low`;

  await send(apiKey, { from, to, subject, html: lowCreditsHtml(params) });
}

/**
 * The 90%-of-ceiling warning, from Shopify's
 * app_subscriptions/approaching_capped_amount webhook.
 *
 * Deliberately not phrased as a problem. The merchant set this ceiling on
 * purpose and it is doing its job; the only thing they need to know is that
 * auto-refill will stop when it is reached, while there is still time to raise
 * it. Warning tone, not alarm.
 */
function capApproachingHtml(p: {
  appUrl: string;
  cappedAmountUsd: number;
  balanceUsedUsd: number | null;
}): string {
  const spent =
    p.balanceUsedUsd != null
      ? `<p style="font-size:14px;color:#555;margin:0 0 8px;">You've used <strong style="color:#1a1a1a;">$${p.balanceUsedUsd.toFixed(2)}</strong> of your <strong style="color:#1a1a1a;">$${p.cappedAmountUsd.toFixed(2)}</strong> monthly auto-refill limit this cycle.</p>`
      : `<p style="font-size:14px;color:#555;margin:0 0 8px;">You're close to your <strong style="color:#1a1a1a;">$${p.cappedAmountUsd.toFixed(2)}</strong> monthly auto-refill limit for this cycle.</p>`;

  return `<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#f6f6f6;margin:0;padding:40px 0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;">
    <div style="background:#b26a00;padding:20px 32px;">
      <h1 style="color:#fff;font-size:18px;font-weight:700;margin:0;">You're nearing your auto-refill limit</h1>
    </div>
    <div style="padding:32px;">
      ${spent}
      <p style="font-size:14px;color:#555;margin:16px 0 28px;">
        When the limit is reached, auto-refill stops for the rest of this billing cycle and your
        credits will run down without topping up. You can raise the limit in the app, or leave it
        as is — it resets at the start of your next cycle.
      </p>
      <a href="${p.appUrl}" style="display:inline-block;background:#1a1a1a;color:#fff;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;">Review auto-refill</a>
      <p style="font-size:12px;color:#999;margin:32px 0 0;">This limit is the ceiling you approved — we can never charge past it without asking you again.</p>
    </div>
  </div>
</body>
</html>`;
}

export async function sendAutorefillCapApproachingEmail(
  apiKey: string,
  from: string,
  to: string,
  params: {
    shopDomain: string;
    appUrl: string;
    cappedAmountUsd: number;
    balanceUsedUsd: number | null;
  },
): Promise<void> {
  await send(apiKey, {
    from,
    to,
    subject: `${params.shopDomain}: nearing your auto-refill spending limit`,
    html: capApproachingHtml(params),
  });
}
