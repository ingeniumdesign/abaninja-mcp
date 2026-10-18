# AbaNinja-API: Eigenheiten

Was beim Bau dieses Servers an der AbaNinja-API aufgefallen ist. Stand Oktober 2026, geprüft gegen die Live-API.

## Grundlagen

- Basis-URL: `https://api.abaninja.ch`
- Authentifizierung: Bearer-Token (`Authorization: Bearer <token>`). Tokens gibt es nur in kostenpflichtigen Abos.
- Fast alle Pfade beginnen mit `/accounts/{accountUuid}/<bereich>/v2/…`. Die Konten eines Tokens liefert `GET /users/v2/me/accounts`.
- Berechtigungen (Scopes) gelten pro Bereich, zum Beispiel `customers`, `products`, `finances` oder `settings`. Getrennte Lese- und Schreibrechte gibt es nicht.
- Offizielle Doku: <https://docs.abaninja.ch/>. OpenAPI-Specs pro Bereich liegen unter `https://docs.abaninja.ch/specs/<bereich>-v2.json`.
- Rate-Limits sind nicht dokumentiert. DeepCloud behält sich in den API-Nutzungsbedingungen Limits vor.

## Abweichungen von der OpenAPI-Spec

- Der Firmenname heisst in der Antwort `company_name`, die Spec nennt ihn `name`.
- Adressen enthalten Felder, die die Spec nicht kennt: `acc_accounts`, `dunning_type`, `enable_dunning`, `enable_dunning_amount`, `global_percent_discount`, `isArchived`.
- Adressen verwenden snake_case, Dokumente camelCase.

## Seitenweises Abrufen

| Bereich | Parameter | Seitenangaben in der Antwort |
| --- | --- | --- |
| Adressen | `page`, `limit` (400 funktioniert) | `meta.total`, `meta.last_page` |
| Dokumente | `page`, `limit` (1 bis 400) | keine: weiterblättern, bis weniger als `limit` Einträge kommen |
| Konten (`/users/v2/me/accounts`) | `page`, `perPage` | `meta.pagination.totalItems` |

## Adressen

- Die Listen von Firmen und Personen liefern die Seitenangaben in `meta` (`total`, `last_page`) und ein `links`-Array, das nur die Antwort aufbläht.

- Firmen und Personen liegen getrennt unter `/addresses/v2/companies` und `/addresses/v2/persons`. Angelegt wird beides über `POST /addresses/v2/addresses`.
- Es gibt keine Suche und keinen Filter «geändert seit», nur `tags[]`. Für eine Suche alle Adressen laden und lokal filtern.
- Die Datensätze haben keine Zeitstempel.
- E-Mail, Telefon und Ähnliches stecken in `contacts[]` mit `type`, `value` und `is_primary`.
- Kontaktpersonen einer Firma stecken in `contact_persons[]`, jeweils mit eigener `uuid`, `salutation` und `contacts`.
- `POST /addresses` antwortet bei möglichen Dubletten mit HTTP 409. Mit `force=true` wird trotzdem angelegt.

## Dokumente

- Listen liefern `{ status, message, data: { documents: [...] } }`.
- `updatedSince` funktioniert mit Datum (`2026-10-01`) und mit Datum und Uhrzeit.
- Rechnungen enthalten unter anderem `status`, `documentTotal`, `openAmount`, `dueDate`, `dunningLevel`, `updatedAt` und `receiver` mit `companyUuid`, `personUuid`, `addressUuid` und `customerNumber`. Den Kunden findet man über `companyUuid` (Firma) oder `personUuid` (Privatperson). `addressUuid` ist die UUID der Postadresse innerhalb des Kunden (`addresses[].uuid`), nicht die des Kunden selbst.
- Entwürfe (`status: draft`) haben bereits einen `openAmount`, sind aber noch keine Forderung. Weitere Status bei offenen Rechnungen: `sent`, `due`, `reminder`.
- Einen Filter nach Kunde gibt es nicht, deshalb wird lokal gefiltert.
- Für Dokumente gibt es viele Aktionen wie `/actions/email`, `/actions/cancel` oder `/bulk-actions/…`. Der Modus `write` sperrt die riskanten davon.

## Webhooks

- Es gibt nur zwei Ereignisse: `payment-received` und `product-updated`.
- Signatur: HMAC-SHA256 über den Rohinhalt, im Header `x-abaninja-signature-sha256`.

## OpenAPI-Specs

- Es gibt Specs für `accounting`, `accounts`, `addresses`, `documents`, `exports`, `finances`, `holidays`, `products`, `time-tracking`, `units`, `warehouse` und `webhooks` (`/specs/<bereich>-v2.json`). Zusammen sind das 539 Endpunkte, davon über die Hälfte in `documents` (die Spec ist rund 2.6 MB gross).
- Die Specs enthalten die Schemas direkt, ohne `$ref`. `npm run catalog` verdichtet sie zu `catalog/endpoints.json`.
