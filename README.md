# PlayerIPTV

Player IPTV para **Samsung Smart TV (Tizen Web App)** compatível com a API **Xtream Codes**.
Interface escura no estilo Netflix / Prime Video, navegação 100% pelo controle remoto e
reprodução de streams HLS (`.m3u8`) com `hls.js` ou com o player nativo da TV.

> Este app **não fornece conteúdo**. O usuário informa a URL/DNS, o usuário e a senha
> do seu próprio provedor na tela de login.

## Funcionalidades

- **Login** com URL/DNS, usuário e senha (aceita também o link M3U `get.php?username=…&password=…`);
  o acesso fica salvo para as próximas aberturas.
- **Hero banner** dinâmico com backdrop, sinopse, nota e ações *Assistir* / *Detalhes*.
- **Menu lateral retrátil**: Início, Filmes, Séries, TV ao Vivo e Configurações.
- **Prateleiras** horizontais por categoria, carregadas sob demanda.
- **Navegação espacial** (setas + OK + VOLTAR), foco com borda e `scale(1.05)`.
- **Detalhes** de filmes e séries (temporadas e episódios).
- **Player** com OSD, avançar/voltar, zapping de canais (▲▼ / CH±), EPG, retomada de
  onde parou e próximo episódio automático.

## Estrutura

```
tizen-app/
├── config.xml      # manifesto do pacote Tizen (permissões e acesso de rede)
├── index.html      # estrutura da interface
├── style.css       # tema e efeitos de foco
├── app.js          # API Xtream, navegação, prateleiras, detalhes e player
└── lib/hls.min.js  # hls.js 1.5 (com fallback para CDN)
```

Compatibilidade: TVs Samsung **Tizen 3.0+** (2017 em diante, Chromium 47+).

## Executar na TV / emulador (Tizen Studio)

1. Importe a pasta `tizen-app/` como projeto **Web** no Tizen Studio.
2. Adicione um `icon.png` (512×423) na raiz de `tizen-app/`.
3. Crie um certificado Samsung no *Certificate Manager*.
4. Execute no **TV Emulator** ou em uma TV com o *Developer Mode* ativado.

## Testar no navegador do PC (homologação)

O servidor Xtream normalmente não envia cabeçalhos CORS, então o navegador precisa ser
aberto com a segurança web desativada **em um perfil isolado** (apenas para testes):

```powershell
# 1) Servir a pasta
python -m http.server 8080 -d tizen-app

# 2) Abrir o Edge (ou Chrome) com perfil separado
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --disable-web-security `
  --user-data-dir="$env:TEMP\edge-iptv-dev" `
  --autoplay-policy=no-user-gesture-required `
  --window-size=1920,1080 `
  --app=http://localhost:8080
```

| Controle      | Teclado              |
|---------------|----------------------|
| Setas / OK    | Setas / Enter        |
| VOLTAR        | Backspace ou Esc     |
| Play/Pause    | Espaço               |
| CH+ / CH−     | Page Up / Page Down  |

O Chrome/Edge do PC não reproduz alguns formatos que a TV suporta (MKV, HEVC, AC3).

## Observações

- As credenciais ficam salvas em `localStorage` sem criptografia.
- Configurações de desempenho (itens por prateleira, buffer, timeouts) ficam no objeto
  `CONFIG` no início de `tizen-app/app.js`.
