# AbaNinja-API: Eigenheiten

Was beim Bau dieses Servers an der AbaNinja-API aufgefallen ist. Stand Oktober 2026, geprüft gegen die Live-API.

## Grundlagen

- Basis-URL: `https://api.abaninja.ch`
- Authentifizierung: Bearer-Token (`Authorization: Bearer <token>`). Tokens gibt es nur in kostenpflichtigen Abos.
- Fast alle Pfade beginnen mit `/accounts/{accountUuid}/<bereich>/v2/…`. Die Konten eines Tokens liefert `GET /users/v2/me/accounts`.
- Berechtigungen (Scopes) gelten pro Bereich, zum Beispiel `customers`, `products`, `finances` oder `settings`. Getrennte Lese- und Schreibrechte gibt es nicht.
- Offizielle Doku: <https://docs.abaninja.ch/>. OpenAPI-Specs pro Bereich liegen unter `https://docs.abaninja.ch/specs/<bereich>-v2.json`.
- Rate-Limits sind nicht dokumentiert. DeepCloud behält sich in den API-Nutzungsbedingungen Limits vor. Der Server wiederholt Anfragen nach HTTP 429 bis zu zweimal und beachtet dabei `Retry-After`.
- `GET /users/v2/me/accounts` braucht den Bereich `profile`. Ohne ihn muss das Konto fest eingestellt werden.
- Listen als Abfrageparameter liest das Backend nur mit `[]` hinter dem Namen (`kind[]=a&kind[]=b`). Der Server hängt das bei Listen selbst an.

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
- E-Mail, Telefon und Ähnliches stecken in `contacts[]` mit `type`, `value` und `is_primary`. Beim Anlegen heisst das Feld `primary`.
- Kontaktpersonen einer Firma stecken in `contact_persons[]`, jeweils mit eigener `uuid`, `salutation` und `contacts`.
- `POST /addresses` antwortet bei möglichen Dubletten mit HTTP 409 und listet sie auf. Mit `force=true` wird trotzdem angelegt. Die Prüfung ist unscharf und vergleicht Firmen und Personen miteinander: Eine Person «ZZ-Testperson abaninja-mcp» gilt als Dublette der Firma «ZZ-Test abaninja-mcp», auch an anderer Adresse.
- Bei Schweizer Adressen (`country_code: CH`) verlangt die API den Kanton in `state` (z. B. `ZH`), obwohl die Spec das Feld nicht als Pflicht führt. Ohne Kanton kommt HTTP 422.
- Per API angelegte Adressen bekommen keine Kundennummer automatisch. Wer eine will, gibt `customer_number` mit und prüft sie vorher mit `GET /addresses/v2/check-customer-number`.
- Eine Firma lässt sich erst löschen, wenn keine Dokumente mehr auf sie verweisen (sonst HTTP 409).

## Dokumente

- Listen liefern `{ status, message, data: { documents: [...] } }`. Auch der Abruf eines einzelnen Dokuments liefert diese Hülle, mit dem Dokument in `data.documents[0]`.
- Ein neues Dokument ist zuerst ein Entwurf (`status: draft`), bekommt aber sofort seine Nummer (z. B. `O0042`). Wird es gelöscht, bleibt diese Nummer als Lücke im Nummernkreis.
- Welche Aktionen ein Dokument gerade erlaubt, zeigt `GET …/{type}/{uuid}/actions`. Bei einem Entwurf fehlt zum Beispiel `email`.
- `PATCH …/actions/delete` entfernt ein Dokument, danach antwortet die API mit HTTP 404.
- `PATCH` auf ein Dokument ersetzt es vollständig: Datum (`quoteDate`, `invoiceDate`), `currencyCode`, `pricesIncludeVat`, `receiver` und `positions` müssen mit, bei Rechnungen auch `paymentInstructions`. Darin ist nur eine Variante erlaubt (zum Beispiel nur `bankAccountUuid`), obwohl die API beim Lesen `bankAccountUuid`, `iban` und `bic` zusammen liefert.
- `POST …/{type}/calculate` rechnet Positionen samt MWST durch, ohne etwas zu speichern. Damit lässt sich eine Offerte oder Rechnung prüfen, bevor sie angelegt wird.
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
- Die meisten Specs enthalten die Schemas direkt, nur die Adressen-Spec verweist mit `$ref` auf `components`. `npm run catalog` löst die Verweise auf und verdichtet alles zu `catalog/endpoints.json`.
- Viele Request-Bodies sind Varianten (`oneOf`/`anyOf`): `receiver` einer Rechnung braucht entweder `companyUuid` oder `personUuid` (jeweils mit `addressUuid`) oder eine `customerNumber`, Positionen unterscheiden sich über `kind` (`product`, `subtitle`, `text`, `group` usw.). Der Katalog markiert Felder, die immer nötig sind, mit `required`. Bedingte Pflichtfelder stehen mit `requiredIf` (z. B. `type=company`) oder `requiredUnless` (z. B. `isTemplate=true`).
- Das Backend ist Laravel und wertet `_method` aus: Ein POST mit `_method=DELETE` wird als DELETE ausgeführt. Die Modi `read` und `write` lassen solche Parameter deshalb nicht durch.
- Einige Endpunkte liefern Dateien (PDF-Vorschau, Logo, ZIP) statt JSON. Der Server zeigt dafür nur Typ und Grösse an. Datei-Uploads (`multipart/form-data`, 12 Endpunkte) kann `abaninja_request` nicht senden; der Katalog markiert sie.
- Zahlungen (`/finances/v2/payments`) können mit `processing.sendPaymentConfirmation` eine E-Mail an den Kunden auslösen. Im Modus `write` ist das gesperrt.
