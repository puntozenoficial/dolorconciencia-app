export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-hotmart-hottok'];
  if (token !== process.env.HOTMART_HOTTOK) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;
  const eventType = event?.event;
  if (eventType !== 'PURCHASE_COMPLETE' && eventType !== 'PURCHASE_APPROVED') {
    return res.status(200).json({ message: 'Event ignored: ' + eventType });
  }

  const buyerEmail = event?.data?.buyer?.email;
  const buyerName = event?.data?.buyer?.name || 'Cliente';
  const productId = event?.data?.product?.id;
  const transaction = event?.data?.purchase?.transaction || null;

  if (!buyerEmail) return res.status(400).json({ error: 'No buyer email' });

  // Mapeo de productos Hotmart -> programa de la app
  const PROGRAMS = {
    7910943: {
      scope: '28dias',
      subtitulo: 'PROTOCOLO 28 DÍAS',
      cta: '¡Empezá tu programa de 28 días!',
    },
    8004113: {
      scope: '14dias',
      subtitulo: 'PROTOCOLO 14 DÍAS · RODILLA Y CADERA',
      cta: '¡Empezá tu programa de 14 días!',
    },
  };

  const program = PROGRAMS[productId];
  if (!program) {
    return res.status(200).json({ message: 'Producto no mapeado: ' + productId });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  // Idempotencia: si esta transacción ya generó un código (p.ej. webhook duplicado
  // o reintento de Hotmart), no generamos uno nuevo ni mandamos otro mail.
  if (transaction) {
    const existing = await fetch(
      `${SUPABASE_URL}/rest/v1/access_codes?hotmart_transaction=eq.${encodeURIComponent(transaction)}&select=code`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const existingRows = existing.ok ? await existing.json() : [];
    if (existingRows.length > 0) {
      return res.status(200).json({ message: 'Ya procesado', code: existingRows[0].code });
    }
  }

  // Generate unique code DC-XXXX-XXXX
  function genCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const part = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `DC-${part(4)}-${part(4)}`;
  }

  let code;
  for (let i = 0; i < 5; i++) {
    const candidate = genCode();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/access_codes`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        code: candidate,
        scope: program.scope,
        email: buyerEmail,
        buyer_name: buyerName,
        hotmart_transaction: transaction,
        hotmart_product_id: productId,
      }),
    });
    if (r.status === 201) {
      code = candidate;
      break;
    }
    if (r.status === 409) {
      // Choque con hotmart_transaction único: otra llamada (webhook duplicado) ya lo procesó
      return res.status(200).json({ message: 'Duplicado, ya procesado por otra llamada' });
    }
  }

  if (!code) return res.status(500).json({ error: 'Could not generate code' });

  // Send email via Resend
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'DolorConCiencia <onboarding@resend.dev>',
      to: buyerEmail,
      subject: '¡Tu acceso a DolorConCiencia App está listo!',
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;background:#faf8f4;">
<div style="text-align:center;margin-bottom:32px;">
<h1 style="color:#4A7A65;font-size:28px;margin:0;">DolorConCiencia</h1>
<p style="color:#888;font-size:13px;letter-spacing:2px;margin:4px 0 0;">${program.subtitulo}</p>
</div>
<p style="font-size:16px;color:#333;">¡Hola ${buyerName}!</p>
<p style="font-size:15px;color:#555;">Tu acceso a la app está listo. Este es tu código personal:</p>
<div style="background:#fff;border:2px solid #4A7A65;border-radius:12px;padding:24px;text-align:center;margin:32px 0;">
<p style="margin:0 0 8px;font-size:12px;color:#888;letter-spacing:1px;">TU CÓDIGO DE ACCESO</p>
<span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#4A7A65;">${code}</span>
</div>
<p style="font-size:15px;color:#555;"><strong>¿Cómo ingresar?</strong></p>
<ol style="font-size:14px;color:#555;line-height:2;">
<li>Andá a <a href="https://dolorconciencia-app.vercel.app" style="color:#4A7A65;">dolorconciencia-app.vercel.app</a></li>
<li>Click en <strong>"Crear cuenta"</strong></li>
<li>Completá tus datos y pegá el código de acceso</li>
<li>${program.cta}</li>
</ol>
<p style="font-size:12px;color:#aaa;margin-top:32px;border-top:1px solid #eee;padding-top:16px;">
Este código es de uso único y personal. No lo compartas.<br>
¿Tenés problemas? Respondé este email y te ayudamos.
</p>
</div>`,
    }),
  });

  return res.status(200).json({ success: true });
}
