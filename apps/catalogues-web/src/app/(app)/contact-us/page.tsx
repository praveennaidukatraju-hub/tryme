'use client';
import { AlertCircle, CheckCircle2, Loader2, Mail, MapPinned, Phone } from 'lucide-react';
import { useState } from 'react';
import { FaFacebookF, FaInstagram, FaLinkedin, FaYoutube } from 'react-icons/fa';
import { C, grad } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { api } from '@/lib/api';

export default function ContactUsPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter your full name.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!phone.trim() || phone.length < 10) {
      setError('Please enter a valid 10-digit phone number.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await api.post('/v1/contact', {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        source: 'contact-us',
        message: message.trim() || undefined,
      });
      setSubmitted(true);
      setName('');
      setEmail('');
      setPhone('');
      setMessage('');
    } catch (err: unknown) {
      console.error('Failed to submit contact message:', err);
      const msg =
        err && typeof err === 'object' && 'error' in err
          ? (err as { error?: { message?: string } }).error?.message
          : err instanceof Error
            ? err.message
            : undefined;
      setError(msg || 'Failed to send message. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <style>{`
        .contact-content-area {
          flex: 1;
          overflow-y: auto;
          background: ${C.bg};
          padding: 40px 24px;
          box-sizing: border-box;
        }

        .contact-container {
          width: 100%;
          max-width: 1156px;
          margin: 0 auto;
          display: flex;
          flex-direction: row;
          justify-content: space-between;
          align-items: stretch;
          gap: 32px;
        }

        .contact-info-card {
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          align-items: flex-start;
          padding: 32px 36px;
          gap: 28px;
          flex: 1 1 500px;
          min-width: 320px;
          max-width: 651px;
          width: 100%;
          background: ${C.card};
          border: 1px solid ${C.border};
          box-shadow: 0px 4px 15px rgba(0, 0, 0, 0.08);
          border-radius: 24px;
        }

        .contact-form-card {
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          align-items: flex-start;
          padding: 32px;
          gap: 20px;
          width: 460px;
          max-width: 100%;
          flex-shrink: 0;
          background: ${C.card};
          border: 1px solid ${C.border};
          box-shadow: 0px 4px 15px rgba(0, 0, 0, 0.08);
          border-radius: 24px;
        }

        .contact-card-title {
          font-size: 26px;
          font-weight: 600;
          color: ${C.text};
        }

        .contact-card-subtitle {
          font-size: 14px;
          color: ${C.mid};
          line-height: 1.5;
        }

        .contact-item-label {
          font-size: 13px;
          font-weight: 600;
          color: ${C.text};
          margin-bottom: 4px;
        }

        .contact-item-val {
          font-size: 14px;
          color: ${C.mid};
          line-height: 1.5;
        }

        .contact-icon-box {
          width: 45px;
          height: 45px;
          min-width: 45px;
          border-radius: 10px;
          border: 1px solid ${C.border};
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .contact-form-label {
          font-size: 12px;
          font-weight: 600;
          color: ${C.text};
          margin-bottom: 6px;
          display: block;
        }

        .contact-submit-btn {
          width: 100%;
          height: 44px;
          background: ${grad};
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
        }

        @media (max-width: 1200px) {
          .contact-content-area {
            padding: 24px 20px;
          }
          .contact-container {
            flex-direction: column;
            align-items: center;
            gap: 24px;
          }
          .contact-info-card {
            width: 100%;
            max-width: 650px;
            padding: 28px 28px;
            gap: 24px;
          }
          .contact-form-card {
            width: 100%;
            max-width: 650px;
            padding: 28px 28px;
            gap: 20px;
          }
          .contact-card-title {
            font-size: 22px;
          }
          .contact-card-subtitle {
            font-size: 13px;
          }
          .contact-item-val {
            font-size: 13px;
          }
          .contact-icon-box {
            width: 40px;
            height: 40px;
            min-width: 40px;
          }
        }

        @media (max-width: 639px) {
          .contact-content-area {
            padding: 16px 16px;
          }
          .contact-container {
            gap: 16px;
          }
          .contact-info-card {
            padding: 20px 16px;
            border-radius: 16px;
            gap: 20px;
          }
          .contact-form-card {
            padding: 20px 16px;
            border-radius: 16px;
            gap: 16px;
          }
          .contact-card-title {
            font-size: 20px;
          }
          .contact-card-subtitle {
            font-size: 12px;
          }
          .contact-item-label {
            font-size: 12.5px;
          }
          .contact-item-val {
            font-size: 12px;
            line-height: 1.4;
          }
          .contact-icon-box {
            width: 36px;
            height: 36px;
            min-width: 36px;
          }
          .contact-submit-btn {
            height: 40px;
            font-size: 13px;
          }
        }

        .contact-input::placeholder {
          color: ${C.light} !important;
          opacity: 1 !important;
          font-weight: 400 !important;
        }
      `}</style>
      <TopBar title="Contact Us" subtitle="" />
      <div className="contact-content-area">
        <div className="contact-container">
          {/* Left - Contact Info */}
          <div className="contact-info-card">
            <div>
              <div className="contact-card-title">Let's Connect</div>
              <div className="contact-card-subtitle">
                Reach out to us through any of the following channels.
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
              {/* Email */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div className="contact-icon-box">
                  <Mail size={18} color={C.mid} />
                </div>
                <div>
                  <div className="contact-item-label">Email</div>
                  <div className="contact-item-val">support@tryme.com</div>
                </div>
              </div>

              {/* Phone */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div className="contact-icon-box">
                  <Phone size={18} color={C.mid} />
                </div>
                <div>
                  <div className="contact-item-label">Phone</div>
                  <div className="contact-item-val">+91 7729883692</div>
                </div>
              </div>

              {/* Corporate Office */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div className="contact-icon-box">
                  <MapPinned size={18} color={C.mid} />
                </div>
                <div>
                  <div className="contact-item-label">Corporate Office</div>
                  <div className="contact-item-val">
                    #904, 9th Floor Asian Sun City Commercial Beside Sarath City Capital Mall
                    Kondapur, Hyderabad, 500084.
                  </div>
                </div>
              </div>

              {/* Head Office */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div className="contact-icon-box">
                  <MapPinned size={18} color={C.mid} />
                </div>
                <div>
                  <div className="contact-item-label">Head Office</div>
                  <div className="contact-item-val">
                    3rd Floor, Salumuri Vari St, above Ishita Mini Function Hall, Innespeta,
                    Rajamahendravaram, Andhra Pradesh, 533101.
                  </div>
                </div>
              </div>
            </div>

            {/* Follow Us */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>
                Follow Us On
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <a
                  href="https://www.facebook.com/Tryme/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Tryme on Facebook"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#1877F2',
                    color: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  <FaFacebookF size={16} />
                </a>
                <a
                  href="https://www.instagram.com/ai_vastra/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Tryme on Instagram"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#E4405F',
                    color: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  <FaInstagram size={16} />
                </a>
                <a
                  href="https://www.youtube.com/@ai.vastra_tryon"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Tryme on YouTube"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#FF0000',
                    color: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  <FaYoutube size={16} />
                </a>
                <a
                  href="https://www.linkedin.com/company/tryme/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Tryme on LinkedIn"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#0A66C2',
                    color: '#fff',
                    textDecoration: 'none',
                  }}
                >
                  <FaLinkedin size={16} />
                </a>
              </div>
            </div>
          </div>

          {/* Right - Contact Form */}
          {submitted ? (
            <div
              className="contact-form-card"
              style={{
                justifyContent: 'center',
                alignItems: 'center',
                textAlign: 'center',
                padding: '48px 32px',
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  background: '#DEF7EC',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 16,
                }}
              >
                <CheckCircle2 size={32} color="#0E9F6E" />
              </div>
              <div className="contact-card-title" style={{ fontSize: 22, marginBottom: 8 }}>
                Message Sent Successfully!
              </div>
              <div className="contact-card-subtitle" style={{ maxWidth: 340, marginBottom: 24 }}>
                Thank you for reaching out. We&apos;ve received your message and will get back to
                you shortly.
              </div>
              <button
                type="button"
                className="contact-submit-btn"
                onClick={() => setSubmitted(false)}
                style={{ width: 'auto', padding: '0 24px' }}
              >
                Send Another Message
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="contact-form-card">
              <div>
                <div className="contact-card-title">Send Us a Message</div>
                <div className="contact-card-subtitle">
                  Share few details, and we&apos;ll contact you soon.
                </div>
              </div>

              {error && (
                <div
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '10px 14px',
                    borderRadius: 8,
                    background: '#FDE8E8',
                    border: '1px solid #F8B4B4',
                    color: '#9B1C1C',
                    fontSize: 13,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <AlertCircle size={16} style={{ flexShrink: 0 }} />
                  <span>{error}</span>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
                {/* Full Name */}
                <div>
                  <label htmlFor="contact-name" className="contact-form-label">
                    Full Name<span style={{ color: '#DC2626' }}>*</span>
                  </label>
                  <input
                    id="contact-name"
                    className="contact-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Matt Borris"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      height: 42,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: '0 12px',
                      fontSize: 13,
                      color: C.text,
                      background: C.field,
                      outline: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                {/* Email */}
                <div>
                  <label htmlFor="contact-email" className="contact-form-label">
                    Email<span style={{ color: '#DC2626' }}>*</span>
                  </label>
                  <input
                    id="contact-email"
                    className="contact-input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="mattborris@email.com"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      height: 42,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: '0 12px',
                      fontSize: 13,
                      color: C.text,
                      background: C.field,
                      outline: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                {/* Phone */}
                <div>
                  <label htmlFor="contact-phone" className="contact-form-label">
                    Phone Number<span style={{ color: '#DC2626' }}>*</span>
                  </label>
                  <input
                    id="contact-phone"
                    className="contact-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    placeholder="9874563210"
                    inputMode="numeric"
                    maxLength={10}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      height: 42,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: '0 12px',
                      fontSize: 13,
                      color: C.text,
                      background: C.field,
                      outline: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                {/* Message */}
                <div>
                  <label htmlFor="contact-message" className="contact-form-label">
                    Your Message
                  </label>
                  <textarea
                    id="contact-message"
                    className="contact-input"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Tell us about your requirements, business, or any questions you have..."
                    rows={3}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      border: `1px solid ${C.border}`,
                      borderRadius: 8,
                      padding: '10px 12px',
                      fontSize: 13,
                      color: C.text,
                      background: C.field,
                      resize: 'vertical',
                      outline: 'none',
                      fontFamily: 'inherit',
                      lineHeight: 1.5,
                    }}
                  />
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={submitting}
                className="contact-submit-btn"
                style={{
                  opacity: submitting ? 0.7 : 1,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={16} className="av-spin" />
                    Sending...
                  </span>
                ) : (
                  'Submit Message'
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
