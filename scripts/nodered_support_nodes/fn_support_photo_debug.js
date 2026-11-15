// No source bytes, signed URLs, references, authorization headers or private ingress state.
return { payload: { ok: msg.statusCode === 200, messageCount: msg.payload?.messages?.length || 0 } };
