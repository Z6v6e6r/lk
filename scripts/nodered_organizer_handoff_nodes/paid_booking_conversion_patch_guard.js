// Legacy browser roster writes cannot confirm additional seats for a paid
// conversion. The booked organizer and existing roster can still be read and edited.
const metadata = game.metadata;
const rawJoinPrice = metadata?.joinPrice;
const joinPrice = typeof rawJoinPrice === "string" && /^\d+(?:[.,]\d+)?$/.test(rawJoinPrice.trim())
  ? Number(rawJoinPrice.trim().replace(",", "."))
  : rawJoinPrice;
const typeId = Number(metadata?.typeId);
const directionId = Number(metadata?.directionId);
const markers = [metadata?.typeName, metadata?.directionName]
  .map(value => String(value || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-z0-9а-я]+/g, ""));
const otherCategory = [605, 847, 963, 1208, 1755, 839, 1013].includes(typeId)
  || [2617, 3284, 4769, 6233].includes(directionId)
  || markers.some(value => /турнир|tournament|американо|americano|мексикано|mexicano|roundrobin|олимп|трен|training|coach|групп|group/.test(value));
const openGame = typeId === 1613 || [4588, 6180].includes(directionId)
  || (!otherCategory && markers.some(value => /игра|игру|game|сплит|split/.test(value)));
const paidConvertedGame = metadata?.source === "cabinet_booking_convert"
  && game.settings?.payMode !== "split" && openGame
  && Number.isFinite(joinPrice) && joinPrice > 0;
if (paidConvertedGame) {
  const blocked = () => {
    msg.statusCode = 409;
    msg.payload = {
      code: "BOOKING_CONVERT_PAID_JOIN_UNAVAILABLE",
      error: "Онлайн-запись с оплатой места для этой брони недоступна.",
    };
    return [null, msg];
  };
  const previous = Array.isArray(game.participants) ? game.participants.slice() : [];
  const normalizeStatus = value => String(value || "INVITED").trim().toUpperCase();
  const samePlayer = (incoming, current) => {
    const id = identity(incoming);
    const number = phone(incoming?.phoneNorm || incoming?.phone);
    const currentNumber = phone(current?.phoneNorm || current?.phone);
    return id ? id === identity(current) && (!number || !currentNumber || number === currentNumber)
      : Boolean(number) && number === currentNumber;
  };
  if (Array.isArray(body.participants)) {
    for (const player of body.participants) {
      const match = previous.findIndex(current => samePlayer(player, current)
        && normalizeStatus(player?.status) === normalizeStatus(current?.status));
      if (match < 0) return blocked();
      previous.splice(match, 1);
    }
  }
  if (body.settings && body.settings.payMode !== undefined && body.settings.payMode !== game.settings?.payMode) {
    return blocked();
  }
  if (body.metadata) {
    for (const key of ["source", "typeId", "typeName", "directionId", "directionName", "joinPrice"]) {
      if (Object.prototype.hasOwnProperty.call(metadata, key)) body.metadata[key] = metadata[key];
      else delete body.metadata[key];
    }
  }
}
