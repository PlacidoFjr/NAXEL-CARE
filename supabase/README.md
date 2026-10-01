# Supabase do Naxel Care

Esta pasta guarda o esquema reproduzível do banco hospedado. A migração cria estrutura e políticas de segurança, mas deliberadamente não cria clientes, ordens ou usuários de demonstração.

## Arquitetura escolhida

- Netlify: site institucional e funções HTTP do painel.
- Supabase Auth: autenticação por e-mail e senha.
- Supabase Postgres: dados relacionais, com `organization_id` em todas as entidades operacionais e RLS por empresa.
- Supabase Storage: evidências em bucket privado `service-evidence`; nunca guardar imagens em base64 dentro do banco.
- SQLite: permanece somente no ambiente local, não deve ser enviado para o deploy.

O painel ainda não deve ser publicado como ambiente de produção. A migração do servidor e da interface para as funções hospedadas é uma etapa separada; esta migração é a fundação do banco.

## Preparar o projeto Supabase

1. Criar um projeto Supabase na região mais próxima disponível (preferencialmente São Paulo) e guardar a senha do banco num gerenciador de senhas.
2. Em Storage, criar `service-evidence` como **private**, limite de arquivo `768 KiB`, tipos permitidos `image/webp` e `image/png`.
3. Aplicar `migrations/202609300001_initial_schema.sql` e depois `migrations/202610010001_return_contact_history.sql`, nessa ordem, no SQL Editor. A primeira configura tabelas, índices, perfis automáticos, auditoria, RLS por organização e regras de acesso ao bucket. A segunda acrescenta a Central de Retorno com histórico de contatos protegido por empresa.
4. Em Authentication, desativar cadastro público. Criar/convidar primeiro usuário pelo Dashboard, com e-mail verificado.
5. Copiar o UUID do usuário em Authentication → Users e executar no SQL Editor, substituindo os valores marcados:

```sql
insert into public.organizations (id, name, slug)
values ('org_naxel', 'NOME REAL DA EMPRESA', 'slug-real-da-empresa');

insert into public.org_members (organization_id, user_id, role)
values ('org_naxel', 'UUID-DO-USUARIO-AQUI', 'Administrador');

insert into public.organization_settings (organization_id, value)
values ('org_naxel', '{"name":"NOME REAL DA EMPRESA","phone":"","city":"Salvador","warrantyDefault":90}'::jsonb);
```

6. Configurar `SUPABASE_URL` e `SUPABASE_ANON_KEY` como variáveis de ambiente do site Netlify. Não colocar `service_role` no navegador, no Git ou no Obsidian. A arquitetura da aplicação usa o JWT do usuário e RLS; não precisa de chave de serviço para operações normais.
7. Só depois da API hospedada estar implementada e os testes de isolamento passarem, preparar um deploy de rascunho privado e testar login, CRUD, upload, assinatura, laudo, logout e recuperação de sessão.

## Privacidade e arquivos

As fotos e assinaturas são dados de atendimento e podem conter dados pessoais. O bucket é privado; as políticas limitam acesso a usuários ativos da organização. O cliente deve reduzir as imagens no navegador e a função precisa validar/reprocessar o conteúdo no servidor antes de guardar. A interface deve usar URLs assinadas de curta duração, não URLs públicas permanentes.

Não migrar o banco SQLite automaticamente nesta fase. Ele contém registros de demonstração. Uma eventual importação posterior deve selecionar apenas dados reais, ser revisada pelo usuário e rodar como migração auditável com backup anterior.
