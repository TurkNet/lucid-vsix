# Lucid-VSX: Local Ollama Integration for VS Code

Bu proje, yerel veya ağ üzerindeki bir Ollama API'sini kullanarak VS Code içinde Copilot benzeri bir deneyim sağlar. Eklenti hem Chat Participant (sohbet) hem de inline code completion (ghost text) özelliklerini destekler.

## Hızlı Başlangıç

1. Bağımlılıkları yükleyin:

```bash
npm install
```

2. Derleyin:

```bash
npm run compile
```

3. Geliştirme / Debug (Extension Development Host):

- VS Code'da proje açıldıktan sonra `F5` tuşuna basın. Yeni bir VS Code penceresi (Extension Development Host) açılacak ve eklenti burada yüklü olacaktır.

4. Ayarları yapılandırın (geliştirme host içinde veya normal VS Code settings):

```json
{
  "lucid.ollamaEndpoint": "http://<OLLAMA_HOST>:11434",
  "lucid.ollamaApiKey": "llm-...",
  "lucid.ollamaExtraHeaders": { "X-Request-Source": "post_text_script" },
  "lucid.enableInlineCompletion": true,
  "lucid.logUnmaskedHeaders": false
}
```

5. Eklentiyi normal VS Code penceresinde kullanmak (paketleme):

```bash
npm run compile
npm install -g vsce
vsce package
# oluşan .vsix'i yükleyin
code --install-extension lucid-vsx-x.x.x.vsix
```

## Çalıştırma / Test

- Geliştirme host (F5) penceresinde Chat panelini açın ve `@lucid` ile sohbet edin.
- Kod tamamlamayı test etmek için herhangi bir kod dosyasında yazın; eğer `lucid.enableInlineCompletion` açıksa ghost text önerileri gelmelidir.

## Ortam Değişkenleri ve Header'lar

- `OLLAMA_EXTRA_HEADERS`: JSON biçiminde ek başlıklar. Örnek:

```bash
export OLLAMA_EXTRA_HEADERS='{"X-Request-Source":"post_text_script"}'
```

- `OLLAMA_API_KEY`: API anahtarı (aynı zamanda `lucid.ollamaApiKey` ayarı ile verilebilir):

```bash
export OLLAMA_API_KEY='tn-llm-...'
```

Eklenti `Content-Type: application/json` başlığını otomatik ekler (eğer ayarlarda belirtilmemişse) ve `X-API-Key` başlığıyla API anahtarını gönderir.

## Stream / Chunk Testi

Ollama'dan gelen yanıtlar chunk'lar halinde (NDJSON veya satır bazlı) olabilir. Proje içinde bir test sunucusu çalıştırarak akışı simüle edebilirsiniz:

```js
// tiny-stream-server.js
const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Merhaba" } }],
      }) + "\n"
    );
    setTimeout(() => {
      res.write(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: " Nasıl yardımcı olabilirim?",
              },
            },
          ],
        }) + "\n"
      );
      res.end();
    }, 500);
  })
  .listen(8089);

// çalıştır: node tiny-stream-server.js
```

Bu sunucuyu çalıştırıp `lucid.ollamaEndpoint`'i `http://localhost:8089` yaparak extension'ı F5 ile test edebilirsiniz; gelen chunk'lar anında gösterilecektir.

## Paketleme & Dağıtım

- `vsce package` ile `.vsix` oluşturun ve `code --install-extension` ile yükleyin.
- Marketplace'e yayınlamak isterseniz `vsce publish` kullanabilirsiniz (yayınlama öncesi `package.json` metadata'sını güncelleyin).

## Hata Ayıklama

- Extension Development Host konsolunda logları görün: `Help → Toggle Developer Tools` veya `Debug Console`.
- Eğer sunucu JSON parse hatası dönerse, eklenti otomatik olarak `Content-Type: application/json` ekler; yine hata alıyorsanız endpoint yolunu ve beklenen gövde formatını kontrol edin.

## Güvenlik Notları

- `lucid.logUnmaskedHeaders` ayarını `true` yaparsanız hassas başlıklar (ör. `X-API-Key`) loglarda açıkça görünür. Production'da kapalı tutun.

---

İsterseniz bu README'ye bir `npm` script (`npm run test-stream`) ekleyip küçük test sunucusunu otomatik başlatacak şekilde ayarlayayım.
