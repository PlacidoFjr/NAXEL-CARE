# Supabase do Naxel Care

Esta pasta guarda o esquema reproduzível do banco hospedado. A migração cria estrutura e políticas de segurança, mas deliberadamente não cria clientes, ordens ou usuários de demonstração.

## Arquitetura escolhida

- Netlify: site institucional e funções HTTP do painel.
- Supabase Auth: autenticação por e-mail e senha.
- Supabase Postgres: dados relacionais, com `organization_id` em todas as entidades operacionais e RLS por empresa.
- Supabase Storage: evidências em bucket privado `service-evidence`; nunca guardar imagens em base64 dentro do banco.
- SQLite: permanece somente no ambiente local, não deve ser enviado para o deploy.

O console global de plataforma e o cadastro de empresas são servidos pela função hospedada; a chave de serviço é usada apenas no servidor para convites e administração, nunca no navegador.

## Preparar o projeto Supabase

1. Criar um projeto Supabase na região mais próxima disponível (preferencialmente São Paulo) e guardar a senha do banco num gerenciador de senhas.
2. Em Storage, criar `service-evidence` como **private**, limite de arquivo `768 KiB`, tipos permitidos `image/webp` e `image/png`.
3. Aplicar as migrações de `migrations/` em ordem numérica. As primeiras configuram dados operacionais, auditoria, RLS, Storage, histórico da Central de Retorno e administração global; a migração mais recente endurece as funções usadas pelas políticas de acesso.
4. Em Authentication → Users, convidar o e-mail inicial de plataforma. Depois da migração, esse usuário entra no console sem vínculo com uma clínica e pode cadastrar a primeira empresa e as contas da equipe.
5. Configurar `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NAXEL_ENABLE_PANEL=true` e `NAXEL_AUTH_REDIRECT_URL` nas variáveis do Netlify. Marcar a chave secreta como segredo. Quando o plano permitir, restringi-la ao runtime das funções; o script de build não usa essa chave. Não colocar a chave no navegador, no Git ou no Obsidian.
6. Em Authentication → URL Configuration, definir `https://naxel-care-os.netlify.app` como Site URL e incluir a URL exata `https://naxel-care-os.netlify.app/painel.html` nas Redirect URLs. O callback remove o fragmento com tokens antes de trocar a sessão por cookies HttpOnly.
7. Antes de liberar novos clientes, confirmar a configuração de e-mail do Supabase e o convite inicial. Manter o cadastro público desligado; usuários entram por convite e recebem um único vínculo ativo de empresa.

## Atividade do projeto Free

O Netlify executa `supabase-keepalive` a cada seis horas em produção. A função faz somente uma leitura limitada (`profiles.id`, no máximo uma linha), usando a chave pública `SUPABASE_ANON_KEY`; ela não usa a chave de serviço nem modifica dados. Isso gera atividade no banco e pode reduzir o risco de pausa por inatividade no plano Free, mas a Supabase não garante que um keep-alive evite a pausa. Projetos pagos não são pausados por inatividade.

O bloqueio de senhas vazadas é opcional no plano Free e exige plano Pro ou superior no Supabase. Os helpers de RLS usam funções internas no schema `naxel_private`; aplique `202610010003_harden_auth_helpers.sql` depois das migrações anteriores.

## Privacidade e arquivos

As fotos e assinaturas são dados de atendimento e podem conter dados pessoais. O bucket é privado; as políticas limitam acesso a usuários ativos da organização. O cliente deve reduzir as imagens no navegador e a função precisa validar/reprocessar o conteúdo no servidor antes de guardar. A interface deve usar URLs assinadas de curta duração, não URLs públicas permanentes.

Não migrar o banco SQLite automaticamente nesta fase. Ele contém registros de demonstração. Uma eventual importação posterior deve selecionar apenas dados reais, ser revisada pelo usuário e rodar como migração auditável com backup anterior.
