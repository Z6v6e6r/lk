const rows = Array.isArray(msg.payload) ? msg.payload : [];
const phone = msg._chatList?.phone || null;

const byGame = new Map();
rows.forEach((row) => {
  if (!row || typeof row !== "object") return;
  const gameId = String(row.gameId || "").trim();
  if (!gameId) return;

  const prev = byGame.get(gameId);
  const rowTs = Number(row.createdTs || 0);
  const prevTs = Number(prev?.createdTs || 0);

  if (!prev || rowTs >= prevTs) {
    byGame.set(gameId, row);
  }
});

const chats = Array.from(byGame.values())
  .sort((a, b) => Number(b.createdTs || 0) - Number(a.createdTs || 0))
  .map((m) => ({
    gameId: m.gameId,
    lastMessage: {
      text: m.text || "",
      type: m.type || "TEXT",
      createdAt: m.createdAt || null,
      createdTs: Number(m.createdTs || 0),
      sender: m.sender || null,
    },
  }));

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  phone,
  total: chats.length,
  chats,
};
return [msg, msg];
