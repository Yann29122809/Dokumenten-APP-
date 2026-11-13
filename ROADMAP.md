# Roadmap – was bewusst (noch) nicht gebaut ist

Die App läuft ohne Server, ohne externe Dienste und ohne Kosten. Alles in
dieser Datei bräuchte mindestens eines davon und wird deshalb erst nach
ausdrücklicher Rückfrage umgesetzt.

## Erinnerungen, Stufe 2: Benachrichtigungen ohne Kalender

Heute: Die App erkennt Fristen, du bestätigst sie, und über „In Kalender
eintragen“ übernimmt die iPhone-Kalender-App die Benachrichtigung. Das
funktioniert ohne Server.

### Web-Push

- **Warum nicht gebaut:** Eine Web-App kann sich nicht selbst zu einem
  späteren Zeitpunkt wecken. Push-Nachrichten muss ein Server zur richtigen
  Zeit an Apples Push-Dienst schicken.
- **Voraussetzungen:**
  - ein Server mit Zeitsteuerung (Cron), z. B. ein kleiner Cloud-Dienst
  - VAPID-Schlüssel (der private Schlüssel gehört nur auf den Server, nie ins Repository)
  - iPhone: iOS 16.4 oder neuer, App **vom Home-Bildschirm** geöffnet, Mitteilungen erlaubt
  - Der Server muss Termine kennen. Damit nichts Persönliches dort liegt,
    würde die App nur „Zeitpunkt + zufällige ID“ übermitteln, nie Titel,
    Beträge oder Absender.
- **Kosten:** je nach Anbieter 0–5 € im Monat
- **Risiko:** Der Server ist ein zusätzlicher Angriffspunkt und muss gewartet werden.

### Telegram-Bot

- **Warum nicht gebaut:** Er braucht einen Server, der den Bot betreibt und zur
  Frist die Nachricht schickt, dazu ein Bot-Token (geheim, nie ins Repository).
- **Voraussetzungen:** Telegram-Konto, Bot über @BotFather, Server mit Cron,
  einmalige Verknüpfung deines Chats mit dem Bot.
- **Kosten:** Telegram ist kostenlos, Kosten entstehen nur für den Server.
- **Datenschutz:** Telegram-Chats sind standardmäßig nicht Ende-zu-Ende-verschlüsselt,
  daher nur den neutralen Text unten senden.

### WhatsApp Business API

- **Warum nicht gebaut:** Sie braucht einen Server, ein Meta-Business-Konto,
  eine verifizierte Telefonnummer und freigegebene Nachrichtenvorlagen.
- **Kosten:** Meta berechnet pro Nachricht (je nach Land wenige Cent), dazu
  kommen die Serverkosten.
- **Voraussetzungen:** Meta Business Manager, WhatsApp-Business-Konto,
  Vorlage für die Nachricht, Server mit Cron, Zugangsschlüssel (nur auf dem Server).

### Neutraler Nachrichtentext (für alle drei Wege)

> Erinnerung: In Folio ist heute eine Frist fällig. Öffne die App für Details.

Keine Titel, Beträge, Absender oder Nummern, denn diese Daten bleiben in der
verschlüsselten App.

## Weitere Ideen ohne Server (später möglich)

- Tags automatisch vorschlagen (z. B. aus dem Absender) und „Garantie bis“ aus dem Kassenbon erkennen
- Share Target für Android (iPhone-Safari unterstützt es nicht, daher weggelassen)
- Native App mit Capacitor (99 €/Jahr Apple-Entwicklerkonto): Apples
  Dokumentenscanner, Texterkennung und echte lokale Mitteilungen

## Folio-Design: Teile, die (noch) fehlen

Diese Punkte zeigt das Design. Sie sind bewusst nicht mit Beispieldaten
nachgebaut, sondern fehlen oder haben einen leeren Zustand.

- **Automatisches Auslösen im Live-Scan:** Heute zeigt der Rahmen, wo das Blatt
  erkannt wird, und du drückst selbst den Auslöser. Automatik bräuchte eine
  zuverlässigere Erkennung (sonst entstehen unscharfe oder doppelte Fotos).
- **Blitz im Live-Scan:** Safari auf dem iPhone gibt die Taschenlampe für
  Web-Apps nicht frei. Der Knopf erscheint nur, wenn das Gerät es erlaubt.
- **Modus „Karte“:** nimmt heute wie „Dokument“ eine Seite auf. Eine eigene
  Form (Scheckkarten-Format, Vorder- und Rückseite) fehlt noch.
- **Dunkler Modus** für die ganze App: Folio ist vorerst immer hell (nur
  Sperrbildschirm und Kamera sind dunkel).
