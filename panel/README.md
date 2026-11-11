# PlayerIPTV Panel

Sistema de ativação e gerenciamento de licenças para o PlayerIPTV, similar aos painéis dos apps Smarters Player, Duplex Play e IBO Player.

## Funcionalidades

### Painel Master (Administrador)
- Dashboard com estatísticas
- Gerenciar revendedores (criar, editar, bloquear, adicionar créditos)
- Visualizar todos os dispositivos
- Gerenciar planos de ativação (dias e custo em créditos)
- Gerenciar pacotes de créditos para venda
- Configurações do sistema (dias de teste, Pix, suporte)

### Painel Revendedor
- Dashboard com seus dispositivos e créditos
- Comprar créditos via Pix
- Ativar dispositivos usando código + créditos
- Renovar e configurar dispositivos (DNS, usuário, senha)
- Histórico de transações

### API do Dispositivo (TV)
- Registrar dispositivo e obter código de ativação
- Verificar status (trial, active, expired, blocked)
- Receber configuração Xtream (DNS, usuário, senha)
- Heartbeat para monitoramento

## Como usar

### Requisitos
- Docker e Docker Compose
- Porta 8080 liberada (ou outra de sua preferência)

### Instalação

1. Clone o repositório:
```bash
git clone https://github.com/seu-usuario/PlayerIPTV.git
cd PlayerIPTV/panel
```

2. Configure as variáveis de ambiente (opcional):
```bash
export SECRET_KEY="sua_chave_secreta_aqui"
export ADMIN_PASSWORD="sua_senha_admin"
```

3. Inicie o container:
```bash
docker-compose up -d --build
```

4. Acesse o painel:
- URL: http://seu-servidor:8080
- Usuário: `admin`
- Senha: `admin123` (ou a definida em ADMIN_PASSWORD)

### Configurar o app da TV

No arquivo `tizen-app/app.js`, configure a URL do painel:

```javascript
var CONFIG = {
  panelUrl: 'http://seu-servidor:8080',
  // ...
};
```

## Fluxo de Ativação

1. **Cliente abre o app na TV** → Aparece um código (ex: K7M-42Q)
2. **Cliente envia o código ao revendedor** (WhatsApp, etc.)
3. **Revendedor acessa o painel** → Ativar Dispositivo
4. **Revendedor digita o código, escolhe o plano e configura o IPTV**
5. **A TV é ativada automaticamente** em até 10 segundos

## Estrutura de Preços (exemplo)

### Planos de Ativação
| Plano      | Dias | Custo (créditos) | Preço sugerido |
|------------|------|------------------|----------------|
| Mensal     | 30   | 1.00             | R$ 15,00       |
| Trimestral | 90   | 2.50             | R$ 35,00       |
| Semestral  | 180  | 4.50             | R$ 60,00       |
| Anual      | 365  | 8.00             | R$ 100,00      |

### Pacotes de Créditos
| Pacote       | Créditos | Bônus | Total | Preço      |
|--------------|----------|-------|-------|------------|
| 10 Créditos  | 10       | 0     | 10    | R$ 100,00  |
| 25 Créditos  | 25       | 2     | 27    | R$ 225,00  |
| 50 Créditos  | 50       | 5     | 55    | R$ 400,00  |
| 100 Créditos | 100      | 15    | 115   | R$ 700,00  |

## API Endpoints

### Públicos (dispositivos)
- `POST /api/v1/device/register` - Registrar dispositivo
- `GET /api/v1/device/{code}/status` - Verificar status
- `POST /api/v1/device/{code}/heartbeat` - Heartbeat

## Tecnologias

- **Backend:** Python 3.11 + FastAPI
- **Banco de dados:** SQLite (pode migrar para PostgreSQL)
- **Frontend:** Bootstrap 5 + Jinja2 Templates
- **Container:** Docker

## Segurança

- Senhas hasheadas com bcrypt
- Tokens JWT para autenticação
- HTTPS recomendado em produção (use um proxy reverso como nginx)

## Próximos passos

- [ ] Integração com gateway de pagamento (Mercado Pago, PagSeguro)
- [ ] Notificações por email/WhatsApp
- [ ] Relatórios e exportação
- [ ] Sub-revendedores (hierarquia multinível)
- [ ] API para integrações externas
