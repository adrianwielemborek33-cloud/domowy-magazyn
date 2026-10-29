
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

async function main() {
  const secret = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!secret) {
    throw new Error("Brak sekretu FIREBASE_SERVICE_ACCOUNT.");
  }

  const serviceAccount = JSON.parse(secret);

  initializeApp({
    credential: cert(serviceAccount)
  });

  const db = getFirestore();

  const household = await db
    .doc("households/domowy-magazyn")
    .get();

  if (!household.exists) {
    throw new Error("Nie znaleziono gospodarstwa domowego.");
  }

  const members = household.data().members || [];

  const inventory = await db
    .doc("households/domowy-magazyn/data/current")
    .get();

  if (!inventory.exists) {
    throw new Error("Nie znaleziono danych magazynu.");
  }

  const products = inventory.data().payload?.products || [];

  const lowProducts = products.filter(p =>
    Number.isFinite(Number(p.qty)) &&
    Number.isFinite(Number(p.min)) &&
    Number(p.qty) <= Number(p.min)
  );

  console.log("Produkty z niskim stanem:", lowProducts.length);

  if (lowProducts.length === 0) {
    console.log("Wszystkie produkty mają odpowiedni zapas.");
    return;
  }

  const names = lowProducts
    .slice(0, 3)
    .map(p => String(p.name || "Produkt"));

  const body = names.join(", ") +
    (lowProducts.length > 3
      ? ` i ${lowProducts.length - 3} więcej.`
      : ".");

  const users = await db.collection("users").listDocuments();

  for (const userRef of users) {
  if (!members.includes(userRef.id)) {
    console.log("Pominięto użytkownika: nie ma go na liście members.");
    continue;
  }

  const devices = await userRef.collection("pushTokens").get();

  console.log("Użytkownik ma dokumentów pushTokens:", devices.size);

  for (const deviceDoc of devices.docs) {
    const device = deviceDoc.data();

    console.log(
      "Sprawdzam urządzenie:",
      "token:", Boolean(device.token),
      "godzina:", device.notificationTime,
      "strefa:", device.timeZone,
      "ostatnia data:", device.lastNotifiedDate
    );

    if (!device.token || !device.notificationTime) {
      console.log("Pominięto urządzenie: brak tokenu lub godziny.");
      continue;
    }
      let localParts;

      try {
        localParts = new Intl.DateTimeFormat("en-GB", {
          timeZone: device.timeZone || "Europe/Warsaw",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        }).formatToParts(new Date());
      } catch (error) {
        console.log("Nieprawidłowa strefa czasowa urządzenia.");
        continue;
      }

      const value = type =>
        localParts.find(part => part.type === type)?.value;

      const today =
        `${value("year")}-${value("month")}-${value("day")}`;

      const currentMinutes =
        Number(value("hour")) * 60 + Number(value("minute"));

      
const match = /^(0?\d|1\d|2[0-3]):([0-5]\d)$/
  .exec(device.notificationTime);


      if (!match) continue;

      const scheduledMinutes =
        Number(match[1]) * 60 + Number(match[2]);

      // Dopuszczamy do 30 minut opóźnienia harmonogramu.
      if (
        currentMinutes < scheduledMinutes ||
        currentMinutes >= scheduledMinutes + 30
      ) {
        continue;
      }

      // Tylko jedno przypomnienie dziennie na urządzenie.
      if (device.lastNotifiedDate === today) continue;

      try {
        await getMessaging().send({
          token: device.token,
          data: {
            title: "Domowy Magazyn — niski stan",
            body: `${lowProducts.length} produktów wymaga uzupełnienia. ${body}`
          },
          webpush: {
            headers: {
              TTL: "3600"
            }
          }
        });

        await deviceDoc.ref.update({
          lastNotifiedDate: today,
          lastNotifiedAt: FieldValue.serverTimestamp()
        });

        console.log("Wysłano przypomnienie dla urządzenia.");

      } catch (error) {
        console.error(
          "Nie udało się wysłać powiadomienia:",
          error.code || error.message
        );
        process.exitCode = 1;
      }
    }
  }
}

main().catch(error => {
  console.error("Błąd harmonogramu:", error.message);
  process.exitCode = 1;
});
