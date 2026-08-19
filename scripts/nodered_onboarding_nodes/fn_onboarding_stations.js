const stations = [
  {
    id: "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1",
    name: "Терехово",
    city: "Москва",
    address: "г Москва, ул Нижние Мнёвники, д 12а",
    lat: 55.743654,
    lng: 37.461122,
    panoramicCourtsCount: 4,
    outdoorCourtsCount: 2,
  },
  {
    id: "0d5504f6-ea6f-44bb-a9e4-947faf0273ab",
    name: "Сколково",
    city: "Москва",
    address: "г Москва, Сколковское шоссе, д 33",
    lat: 55.704392,
    lng: 37.403414,
    panoramicCourtsCount: 6,
    singleCourtsCount: 1,
  },
  {
    id: "6b2d7e60-caff-4b22-89f6-6f19d7d311ab",
    name: "Нагатинская",
    city: "Москва",
    address: "г Москва, проезд Нагатинский 1-й, д 2 стр 17",
    lat: 55.683666,
    lng: 37.632422,
    panoramicCourtsCount: 7,
    singleCourtsCount: 2,
  },
  {
    id: "42c6d4df-833d-480a-bdc8-986716569884",
    name: "Нагатинская Премиум",
    city: "Москва",
    address: "г Москва, проезд Нагатинский 1-й, д 2 стр 40бн",
    lat: 55.684889,
    lng: 37.630005,
    panoramicCourtsCount: 5,
    singleCourtsCount: 2,
  },
  {
    id: "588b6151-f4f5-47d9-9449-80edf8cbc748",
    name: "Ясенево",
    city: "Москва",
    address: "г Москва, ул Паустовского, д 4А",
    lat: 55.601849,
    lng: 37.536005,
    panoramicCourtsCount: 4,
  },
  {
    id: "3656cbaa-6426-490f-a44f-915404cbdd2b",
    name: "Селигерская",
    city: "Москва",
    address: "г Москва, ул Ивана Сусанина, д 1",
    lat: 55.869248,
    lng: 37.521453,
    panoramicCourtsCount: 3,
    singleCourtsCount: 1,
  },
  {
    id: "planned-shcherbinka",
    name: "Щербинка",
    city: "Москва",
    address: "",
    panoramicCourtsCount: null,
    isActive: false,
  },
  {
    id: "1ea77cbf-bc36-49a1-96d6-f35c216a409b",
    name: "Питер",
    city: "Санкт-Петербург",
    address: "г Санкт-Петербург, Пулковское шоссе, уч 25",
    panoramicCourtsCount: null,
  },
  {
    id: "233c1405-1eac-40de-8ec6-1cf7e24c9276",
    name: "Сочи",
    city: "Сириус",
    address: "Краснодарский край, пгт Сириус, Олимпийский пр-кт, д 2Б",
    lat: 43.407025,
    lng: 39.950883,
    panoramicCourtsCount: 4,
  },
  {
    id: "planned-kotelniki",
    name: "Котельники",
    city: "Котельники",
    address: "",
    panoramicCourtsCount: null,
    isActive: false,
  },
  {
    id: "planned-lyubertsy",
    name: "Люберцы",
    city: "Люберцы",
    address: "",
    panoramicCourtsCount: null,
    isActive: false,
  },
  {
    id: "planned-kolomna",
    name: "Коломна",
    city: "Коломна",
    address: "",
    panoramicCourtsCount: null,
    isActive: false,
  },
];

const serviceByStation = {
  "6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1": {
    masterServiceId: "2f4155ad-7bc0-4a15-a12c-da7fce15c37a",
    preferredSubServiceId: "415edff9-b4ad-4d88-8709-75f1ab7d4081",
    subServiceIds: ["415edff9-b4ad-4d88-8709-75f1ab7d4081"],
  },
  "0d5504f6-ea6f-44bb-a9e4-947faf0273ab": {
    masterServiceId: "e2caa535-6660-479a-bd32-3638ba7f6b89",
    preferredSubServiceId: null,
    subServiceIds: ["96d2179a-5a96-41bd-a0c9-1df9e5890e16"],
  },
  "6b2d7e60-caff-4b22-89f6-6f19d7d311ab": {
    masterServiceId: "22b928b2-1ba6-4491-bc43-756676fcd723",
    preferredSubServiceId: null,
    subServiceIds: ["4d1df04c-774f-46ff-93bd-fd1cca0cb1c4"],
  },
  "42c6d4df-833d-480a-bdc8-986716569884": {
    masterServiceId: "1c54e3b4-0421-482e-8faf-0c1cd5fdaf3d",
    preferredSubServiceId: null,
    subServiceIds: ["59fdd182-ce16-4c37-a814-a45cb026d24d"],
  },
  "588b6151-f4f5-47d9-9449-80edf8cbc748": {
    masterServiceId: "d9a5061a-e027-4960-9029-4bf5ec8a0c64",
    preferredSubServiceId: null,
    subServiceIds: ["2689586b-e7f6-4389-bdd2-5c1a35d4c0e7"],
  },
  "3656cbaa-6426-490f-a44f-915404cbdd2b": {
    masterServiceId: "cf54da75-52dd-48bb-861e-c6d53abc052a",
    preferredSubServiceId: null,
    subServiceIds: ["8fd8fe7b-9563-4b56-836c-1b63fe4698f5"],
  },
  "1ea77cbf-bc36-49a1-96d6-f35c216a409b": {
    masterServiceId: "899db365-5286-43f6-a3a4-efcf406a28eb",
    preferredSubServiceId: "6a16a7a8-db84-422d-b5f8-5fd00fe0d54c",
    subServiceIds: ["6a16a7a8-db84-422d-b5f8-5fd00fe0d54c"],
  },
  "233c1405-1eac-40de-8ec6-1cf7e24c9276": {
    masterServiceId: "86e13da6-2282-4daf-9239-c0cd3ddefaf7",
    preferredSubServiceId: null,
    subServiceIds: ["50d7e7a0-39ea-4ccd-a912-a6ddb77fa3ed"],
  },
};

const enrichedStations = stations.map((station) => {
  const cfg = serviceByStation[station.id] || {};
  const subServiceIds = Array.isArray(cfg.subServiceIds)
    ? cfg.subServiceIds.filter(Boolean)
    : [];
  const preferredSubServiceId = cfg.preferredSubServiceId || subServiceIds[0] || null;

  return {
    ...station,
    isActive: station.isActive !== false,
    masterServiceId: cfg.masterServiceId || null,
    preferredSubServiceId,
    subServiceIds,
  };
});

const notConfigured = enrichedStations
  .filter((station) => station.isActive && (!station.masterServiceId || !station.preferredSubServiceId))
  .map((station) => `${station.name} (${station.id})`);

if (notConfigured.length) {
  node.warn(
    "[LK stations] Не заполнены service IDs для станций: " + notConfigured.join(", "),
  );
}

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = { stations: enrichedStations };
return msg;
