msg.statusCode = 500;
msg.headers = { 'content-type': 'application/json; charset=utf-8' };
msg.payload = { error: 'COMMUNITY_PLAYER_RATING_INTERNAL_ERROR' };
return msg;
