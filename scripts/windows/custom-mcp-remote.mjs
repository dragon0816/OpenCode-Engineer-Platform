import { request } from 'node:https';
import { pinCustomRemoteMcp } from '../../apps/adapter/src/runs/custom-mcp.ts';

export async function sendRemoteMcp(server, message, session, headers, signal) {
  const address = await pinCustomRemoteMcp(server, signal).catch(() => { throw new Error('url'); });
  const payload = JSON.stringify(message);
  return await new Promise((resolve, reject) => {
    const upstream = request(server.url, {
      method: 'POST', signal, family: 4, agent: false, rejectUnauthorized: true,
      lookup: (_name, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }])
        : callback(null, address, 4),
      headers: {
        ...headers, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(session.id && { 'Mcp-Session-Id': session.id }),
        ...(session.version && { 'MCP-Protocol-Version': session.version }),
      },
    }, (response) => {
      response.on('error', () => reject(new Error('exited')));
      const code = response.statusCode;
      if (code >= 300 && code < 400 || code === 401 || code === 403 || code >= 400) {
        response.destroy();
        reject(Object.assign(new Error(code < 400 ? 'url' : code === 401 || code === 403 ? 'auth' : 'exited'), {
          status: code, challenge: response.headers['www-authenticate'],
        }));
        return;
      }
      const id = response.headers['mcp-session-id'];
      if (typeof id === 'string' && /^[\x21-\x7e]{1,256}$/.test(id)) session.id = id;
      if (message.id === undefined) {
        response.destroy();
        resolve(undefined);
        return;
      }
      const type = response.headers['content-type']?.split(';')[0];
      if (type !== 'application/json' && type !== 'text/event-stream') {
        response.destroy();
        reject(new Error('exited'));
        return;
      }
      let bytes = 0;
      let pending = '';
      const decoder = new TextDecoder();
      const accept = (data) => {
        try {
          const reply = JSON.parse(data);
          if (reply.jsonrpc !== '2.0' || reply.id !== message.id) return false;
          const version = reply.result?.protocolVersion;
          if (message.method === 'initialize' && /^\d{4}-\d{2}-\d{2}$/.test(version)) session.version = version;
          resolve(reply);
          return true;
        } catch { return false; }
      };
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { response.destroy(); reject(new Error('exited')); return; }
        pending += decoder.decode(chunk, { stream: true });
        if (type !== 'text/event-stream') return;
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
          const data = pending.slice(0, boundary.index).split(/\r?\n/)
            .filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          pending = pending.slice(boundary.index + boundary[0].length);
          if (accept(data)) { response.destroy(); return; }
        }
      });
      response.on('end', () => {
        if (type !== 'application/json' || !accept(pending + decoder.decode())) reject(new Error('exited'));
      });
    });
    upstream.on('error', (error) => reject(new Error(signal.aborted ? 'timeout' :
      /TLS|SSL|CERT|SELF_SIGNED|VERIFY_LEAF|ISSUER/.test(error.code ?? '') ? 'tls' : 'exited')));
    upstream.end(payload);
  });
}
