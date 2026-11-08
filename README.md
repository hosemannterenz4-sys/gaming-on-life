# Gaming On Life – Online Stadt-Land-Fluss

## Lokal testen
1. Node.js 18 oder neuer installieren.
2. Im Projektordner `npm install` ausführen.
3. `npm start` ausführen.
4. Im Browser `http://localhost:3000` öffnen.

## Online veröffentlichen (Render)
1. ZIP entpacken und den gesamten Ordner in ein neues GitHub-Repository hochladen.
2. Bei https://render.com anmelden und **New → Web Service** wählen.
3. Das GitHub-Repository verbinden.
4. Render erkennt `render.yaml`; alternativ Build Command `npm install`, Start Command `npm start` eintragen.
5. Deploy starten. Danach die Render-URL an alle Mitspieler schicken.

## Funktionen
- Echte Echtzeit-Räume über Socket.IO, Raum-Code, bis zu 20 Spieler pro Raum
- Gemeinsamer serverseitiger Countdown und zufälliger Buchstabe
- Mehrere Runden und Rangliste/Punktesummen im Raum
- 20 Punkte einzigartige Antwort, 10 Punkte gleiche Antwort, 0 Punkte leer/falscher Anfangsbuchstabe

## Hinweise
- Räume und Punkte liegen aktuell im Arbeitsspeicher des Servers. Bei einem Neustart werden aktive Räume zurückgesetzt.
- Inhaltliche Korrektheit (ob z. B. eine Antwort wirklich ein Land ist) wird nicht automatisch durch ein Lexikon geprüft; die Spielgruppe sollte die Auswertung kontrollieren.
- Das ist ein lauffähiges Multiplayer-Grundgerüst, aber noch kein dauerhaft gespeichertes Turnier-/Account-System.


Neue Funktionen: Beim Erstellen eines Raums können Kategorien und die Anzahl der Runden (3, 5, 10 oder 15) gewählt werden. Nach jeder Runde sehen alle Spieler die eingetragenen Antworten und Punkte.
