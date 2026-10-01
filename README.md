# Naxel Care OS

Protótipo funcional local para organizar o ciclo completo do atendimento técnico: cliente, equipamento, ordem de serviço, execução em campo, evidências, assinatura, garantia, laudo e a Central de Retorno.

## Central de Retorno

A fila reúne manutenções próximas e vencidas, permite buscar por cliente/serviço/equipamento, abrir uma mensagem preparada no WhatsApp, registrar o resultado do contato e consultar o histórico por oportunidade. Um retorno também pode virar ordem de serviço. A interface separa o valor potencial das OS criadas; não contabiliza oportunidade como receita realizada.

No servidor local, o histórico fica em `contact_attempts` no SQLite. Para o ambiente hospedado, aplicar a migração `supabase/migrations/202610010001_return_contact_history.sql` depois da migração inicial. Ela habilita os resultados da Central, aplica RLS ao histórico e cria uma função transacional para registrar contato e atualizar o retorno.

## Como abrir

1. Dê dois cliques em `Iniciar Naxel Care.cmd`.
2. A apresentação comercial abrirá em `http://127.0.0.1:5001`.
3. No primeiro início, consulte `data/naxel-demo-access.txt` para obter a senha aleatória da conta local. Guarde-a em local seguro; o arquivo é ignorado pelo Git.
4. Entre com o e-mail local `admin@naxel.local` e a senha gerada.

Você também pode definir `NAXEL_DEMO_PASSWORD` no ambiente antes do primeiro início. Se a base local já tiver sido criada, alterar essa variável não troca a senha existente.

Os dados ficam no banco local `data/naxel-care.sqlite`. A aplicação oficial usa o frontend em `public/` e o servidor `server-secure.js`; a pasta `dist/` é apenas um artefato antigo e não deve ser publicada.

## Segurança já aplicada no MVP local

- Senhas protegidas com `scrypt`, incluindo migração automática do hash antigo no login.
- Sessões persistentes, revogáveis e com expiração de 12 horas.
- Cookie `HttpOnly`, `SameSite=Strict` e `Secure` quando executado em produção.
- Proteção CSRF nas operações que alteram dados.
- Isolamento de dados por empresa em todas as rotas operacionais.
- Permissões de backend para Administrador, Gestor e Técnico.
- Validação de textos, datas, valores, imagens e relacionamentos entre registros.
- Limite de tentativas de login por IP e por conta.
- Cabeçalhos CSP, HSTS em produção, proteção contra iframe e MIME sniffing.
- Auditoria de login, alterações, conclusões, exportações e restaurações.
- Testes automatizados de autenticação, CSRF, permissões e isolamento multiempresa.

## Otimização de imagens

As fotos de atendimento são redimensionadas no navegador para no máximo 1600 px no maior lado e convertidas preferencialmente para WebP antes de serem salvas. Quando WebP não está disponível, o sistema usa JPEG. A qualidade também é reduzida progressivamente quando necessário, evitando que evidências fotográficas consumam armazenamento em excesso.

## Hospedagem

A arquitetura escolhida para a fase hospedada é Netlify (site e funções) + Supabase (Auth, PostgreSQL e Storage privado). A migração do esquema e a API serverless estão sendo preparadas em `supabase/` e `netlify/functions/`. O deploy institucional permanece sem o painel enquanto o projeto Supabase e as variáveis de função não forem configurados.

Para incluir o painel no pacote de deploy, configurar `NAXEL_ENABLE_PANEL=true` no ambiente de build da Netlify somente depois de aplicar a migração, criar o primeiro usuário/empresa, criar o bucket privado e concluir os testes de autenticação, RLS, operações e upload. Com a variável ausente ou falsa, o build publica apenas a página institucional. Não envie `data/naxel-care.sqlite`, imagens locais, contas fictícias ou senha para a hospedagem.

Instruções do banco e do primeiro acesso: [`supabase/README.md`](supabase/README.md). O arquivo `.env.example` contém apenas nomes e valores de exemplo; o endereço e a chave anon reais devem ser configurados como variáveis do site Netlify, nunca commitados.

## Verificação técnica

```powershell
npm run check
```

O comando valida a sintaxe e executa a suíte de segurança. Configurações públicas de exemplo estão em `.env.example`; credenciais e segredos não devem entrar no Git.

## Observação

Esta versão continua sendo um MVP local endurecido, não uma produção pública. Antes do primeiro cliente real ainda faltam, principalmente: PostgreSQL gerenciado, recuperação de senha e verificação de e-mail, HTTPS e domínio, armazenamento privado externo para imagens, backup remoto testado, políticas LGPD, monitoramento e homologação móvel.
