import { Hono } from 'hono';
import { pingBedrockServer } from '../lib/bedrock-ping';

const app = new Hono();

// Query Bedrock server status
app.get('/status', async (c) => {
  const ip = c.req.query('ip');
  const port = parseInt(c.req.query('port') || '19132', 10);
  const timeout = parseInt(c.req.query('timeout') || '5000', 10);

  if (!ip) {
    return c.json({ error: 'IP address is required' }, 400);
  }

  try {
    const result = await pingBedrockServer(ip, port, timeout);
    
    if (!result.online) {
      return c.json({ online: false, error: 'Server offline or unreachable' });
    }

    return c.json({
      online: true,
      players: {
        online: result.playerCount || 0,
        max: result.maxPlayers || 0,
      },
      motd: result.motd || '',
      version: result.version || '',
      gamemode: result.gamemode || '',
    });
  } catch (error) {
    return c.json({ online: false, error: 'Server offline or unreachable' });
  }
})

// Verify DNS TXT record for server ownership
app.get('/verify', async (c) => {
  const ip = c.req.query('ip');
  const code = c.req.query('code');

  if (!ip || !code) {
    return c.json({ error: 'IP and code are required' }, 400);
  }

  try {
    const expectedRecord = `bedrocknexus-verify=${code}`;
    
    // Use Google DNS-over-HTTPS
    const response = await fetch(
      `https://dns.google/resolve?name=${encodeURIComponent(ip)}&type=TXT`
    );
    
    if (!response.ok) {
      return c.json({ verified: false, error: 'DNS lookup failed' });
    }

    const data = await response.json() as { Answer?: Array<{ data?: string }> }
    
    if (!data.Answer || data.Answer.length === 0) {
      return c.json({ verified: false, error: 'No TXT records found' });
    }

    const verified = data.Answer.some((record) => {
      const recordData = record.data?.replace(/"/g, '') || ''
      return recordData === expectedRecord
    });

    return c.json({ verified });
  } catch (error) {
    return c.json({ verified: false, error: 'Verification failed' });
  }
})

// Generate verification code
app.get('/generate-code', async (c) => {
  const code = Math.random().toString(36).substring(2, 10).toUpperCase();
  return c.json({ code });
})

export default app
