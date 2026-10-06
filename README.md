# Nachsitzplan für IServ

Einfache Seite für Lehrkräfte zur gemeinsamen Nachsitz-Planung.
Personenbezogene Schülerdaten – nur im geschützten IServ-Bereich nutzen.

## So stellt ihr es in IServ bereit

1. In IServ einen **Gruppenordner nur für Lehrkräfte** anlegen, z. B. `Nachsitzplan`.
2. Diese Dateien hochladen:
   - `index.html`
   - `css/style.css`
   - `js/app.js`
   - `nachsitzplan.json` (gemeinsame Plan-Datei)
3. Kolleginnen und Kollegen öffnen `index.html` aus diesem Ordner (nach IServ-Login).
4. Arbeitsablauf:
   - **Plan laden** → aktuelle `nachsitzplan.json` aus IServ wählen
   - Einträge bearbeiten
   - **Plan speichern** → Datei wird heruntergeladen
   - In IServ die alte `nachsitzplan.json` durch die neue ersetzen

## Datenschutz

- Keinen öffentlichen Link setzen
- Nicht auf der Schulhomepage verlinken
- Ordnerrechte nur für Lehrkräfte
- Fertige/alte Einträge regelmäßig löschen oder als erledigt markieren und aufräumen
- Lokalen Browser-Entwurf bei Bedarf über „Lokalen Entwurf löschen“ entfernen

## Hinweis zur Zusammenarbeit

IServ liefert die Seite und die Datei aus dem geschützten Dateibereich.
Gleichzeitiges Bearbeiten durch mehrere Personen kann zu Überschreibungen führen:
Immer zuerst die aktuelle JSON laden, dann speichern und wieder hochladen.
