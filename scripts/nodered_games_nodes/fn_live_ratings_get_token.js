msg.method = "POST";
msg.url = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";
return [null, msg, null];
