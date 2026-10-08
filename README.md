# Nachsitzplan

Gemeinsame Nachsitz-Liste für Lehrkräfte. Die Seite kann über GitHub Pages veröffentlicht werden. Einträge stehen nicht nur im Browser: sie werden verschlüsselt in `data/plan.json` im Repository gespeichert und sind nach der Anmeldung auf allen Geräten sichtbar.

## Einmalig einrichten

1. Auf GitHub einen Fine-grained Token anlegen: Profil → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Nur dieses Repository auswählen. Bei **Contents** die Berechtigung **Read and write** setzen.
3. In `js/config.js` Owner, Repository-Name und Token eintragen.
4. Die Datei auf GitHub aktualisieren.
5. Seite öffnen, mit dem bisherigen Benutzernamen anmelden und das neue gemeinsame Passwort festlegen. Dieses Passwort nur an Lehrkräfte weitergeben, nicht in eine Datei schreiben.

Die Seite führt durch dieselben Schritte, wenn `js/config.js` noch leer ist.

## Veröffentlichen

Repository → **Settings** → **Pages** → **Deploy from a branch** → Branch `main` → Ordner `/ (root)`.

Die Adresse sieht so aus: `https://BENUTZER.github.io/REPOSITORY/`

## Bedienung

- Name eintragen, Nachsitz hinzufügen, erledigen, Elternvermerk setzen oder löschen. Die Änderung wird für alle Geräte gespeichert.
- **Statistik** zählt gleiche Namen zusammen.
- **Sicherung** lädt eine Kopie herunter. Vor längeren Ferien eine Sicherung speichern. **Sicherung laden** ersetzt die gemeinsame Liste.

## Datenschutz

- GitHub Pages ist eine öffentliche Adresse. Wer sie kennt, sieht die Anmeldeseite.
- Schülernamen liegen verschlüsselt in `data/plan.json`. Ohne das gemeinsame Passwort ist die Datei nicht lesbar.
- Das bisherige Passwort stand in der alten `js/app.js`. Es wird beim ersten Verbinden durch ein neues ersetzt.
- Den GitHub-Token nur für dieses Repository freigeben. Das Repository soll nur diese Seite enthalten.
- Die Seite nicht auf der Schulhomepage verlinken.
- Erledigte Einträge löschen, wenn sie nicht mehr gebraucht werden.
