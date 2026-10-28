# Sigma T3: передача стану наступному агенту

Стан на 27.10.2026. Власник: Дмитро Ренкас (GitHub `drenkas`). Документ написано під час переходу власника на корпоративний акаунт Claude: усе, що жило в треди, артефакти й налаштування старого акаунта, зведено тут. Правила роботи з кодом лишаються в [AGENTS.md](../AGENTS.md) і [docs/operations/sigma-fork.md](operations/sigma-fork.md); цей файл про стан, рішення і відкриті питання.

## 1. Мета

Sigma T3 (`drenkas/sigma-t3`) це форк T3 Code (`pingdotgg/t3code`). Ми беремо T3 як базу й поверх нього додаємо те, що потрібно власнику, переносячи ідеї зі старого проєкту Sigma (`drenkas/Sigma`):

- оркестрація агентів і її візуалізація у вигляді графа;
- проєкти на кілька папок/репозиторіїв;
- робота з Git у всіх папках проєкту;
- щоденна синхронізація з upstream T3, щоб не відставати.

Старий Sigma (Tauri + SolidJS + Pi SDK, версія 0.21.0, власні `HANDOFF.md`/`PLAN.md` у корені) більше не розвивається. Він лишається джерелом ідей і коду для порівняння; переносимо поведінку, а не код один в один.

## 2. Що вже зроблено (усе в `main`)

| Можливість                                                                                                                                                                                                               | Де в коді                                                                                                                                                       | Коміт / PR                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Ідентичність форку: назва Sigma T3, `com.drenkas.sigma-t3`, схеми `sigma-t3`/`sigma-t3-dev`, дані в `~/.sigma-t3`, телеметрія вимкнена, оновлення лише з `drenkas/sigma-t3`                                              | див. `docs/operations/sigma-fork.md`                                                                                                                            | `a6c9fc9e` (#1) і далі                      |
| Окремий мігратор таблиць форку (`sigma_sql_migrations`), не чіпає нумерацію upstream                                                                                                                                     | `apps/server/src/persistence/SigmaMigrations.ts`                                                                                                                | #5                                          |
| Граф лінії будь-якого треду (батьки, форки, субагенти, передачі контексту), перемикач List/Graph у секції Lineage, кольори ролей, легенда, зум/пан/Fit                                                                   | `apps/web/src/components/graph/ExecutionGraph.tsx`, `executionGraphLayout.ts`                                                                                   | `a106902a`, `42606280` (#10–#12)            |
| Проєкти на кілька папок: перша папка це cwd агента, решта передаються провайдерам (Claude/Cursor/ACP як additional directories, Codex як writable roots). OpenCode, Pi, Muse бачать лише головну                         | контракт `additionalWorkspaceRoots` у `packages/contracts/src/project.ts`, розділ **Folders** у Project settings (вибір через Finder і drag&drop, лише desktop) | `50c6030c` (#16)                            |
| Git для кожної додаткової папки: вибір/створення гілки, Commit, Push/Publish, Pull                                                                                                                                       | панель деталей чату                                                                                                                                             | `3a3b836c`, `cc6529f2` (#17)                |
| Pull пояснює причину відмови і робить rebase розбіжних локальних комітів (з відкатом при конфлікті)                                                                                                                      | сервер, git                                                                                                                                                     | `4e0c9c21` (#20)                            |
| Команда `/roles`: зберігає команду агентів (роль → модель) у налаштуваннях сервера через MCP-інструмент `team_roles_set`; додається на початку кожного нового чату поруч з правилами оркестрації; `/roles clear` видаляє | сервер + web + mobile                                                                                                                                           | `d3d60b5c` (#18)                            |
| Ребрендинг: лого сигма-граф з бейджем T3, «Sigma T3» на всіх поверхнях; технічні ідентифікатори upstream не перейменовано, щоб merge лишались малими                                                                     | іконки, web, mobile                                                                                                                                             | `61194c38`, `d1f41574`                      |
| Локальний голосовий ввід: модель Parakeet TDT v3 (~670 МБ) через sherpa-onnx на сервері; Settings → General → Voice input → Download model, кнопка мікрофона в композері                                                 | `apps/server/src/speech/`, RPC `speech.*`                                                                                                                       | `47ce1027`, `64a6f2ba`, ліцензії `834deccb` |
| Скрипт локальної preview-збірки й встановлення в `/Applications`                                                                                                                                                         | `scripts/sigma-preview-install.sh`, `pnpm run sigma:preview-install`                                                                                            | `c38405b6`, `7a6584ae`                      |
| Помічник синхронізації з upstream                                                                                                                                                                                        | `scripts/sigma-upstream-sync.mjs`, `docs/operations/sigma-upstream-sync.md`                                                                                     | `fd4248da` (#3)                             |

### Що свідомо прибрали

**Repository tasks** (групи репозиторіїв, агент-координатор, учасники, автозлиття worktree, Timeline, панель моделей ролей) спершу були перенесені (#5–#11), а 22.10 видалені (`1f6b2e19`, #14). Причина: власник хотів не окрему сторінку задач з координатором, а звичайний чат, якому дали 2+ папки, як проєкт у Codex. Таблиці в уже наявних базах лишились, записи в `SigmaMigrations.ts` теж не можна видаляти, бо вони тримають старі бази робочими. PR #13 (панель моделей ролей) закрито без злиття; замість нього `/roles`.

## 3. Що лишилось з плану переносу

План складався з 12 кроків (артефакт «План переносу Sigma → Sigma T3» на старому акаунті). Після відмови від Repository tasks кроки 6 і 9 переписані під папки й виконані (#17). Власник 22.10 поставив решту **на паузу** («поки що відбій»). Залишок, у порядку, який радив попередній агент:

1. **Diff і checkpoint для додаткових папок.** Найбільша реальна дірка: агент змінює додаткові папки, а в панелі змін цього не видно і відкотити не можна. Зачіпає ядро checkpointing.
2. **Stash** для кожної папки.
3. **Worktrees** папок проєкту: список, перехід, видалення.
4. **Точки входу**: команди в палітрі й MCP-інструменти, щоб агент сам комітив/пушив/пулив у додаткових папках.
5. Основна папка досі має стару схему T3 («Commit, push & PR» + рядок Changes), а додаткові нову. Власник сказав «залиш поки, побачимо що зручніше».

Мобільний клієнт не чіпаємо (рішення власника). Ліміт папок на проєкт 20.

## 4. Відкриті питання й блокери (на 27.10)

| Тред                                               | Стан                        | Що потрібно                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Розробка Sigma через саму Sigma**                | Чекає на відповідь власника | Після перезбірки «зникли» чати. Причина знайдена: dev-режим пише в `~/.sigma-t3/dev` (23 чати, 4 проєкти), встановлена програма читає `~/.sigma-t3/userdata`. Запропоновано: закрити Sigma T3, зробити резервну копію `userdata`, скопіювати туди dev-базу з вкладеннями. Чекаємо на слово «переносимо» і відповідь, чи створювались чати в самій встановленій програмі. Нічого ще не переносилось.                                                                                                                                                                                 |
| **Перевірити роботу preview з мобільною апкою T3** | Гілка не злита              | Мобільна T3 Code з App Store працює з форком лише через пряме підключення (LAN або Tailscale, QR у Settings → Connections). T3 Connect у форку вимкнено свідомо. На прохання власника («давай 1 варіант») зроблено гілку `claude/project-thread-btj5yt` (коміт `6e958b29`), яка повертає офіційний Connect (`app.t3.codes`, публічні relay/Clerk-ідентифікатори з `.env.example`). Вона суперечить межам форку в `sigma-fork.md`, не перевірена (вхід Clerk може не прийняти схему `sigma-t3://` і ad-hoc підпис; passkey точно не працюватиме). Чекає рішення власника про злиття. |
| **Голосовий ввід як в Orca**                       | Чекає на тест               | MVP у `main`. Потрібна перевірка власником на preview-збірці Mac (мікрофон, завантаження моделі). Не зроблено: гаряча клавіша, вибір мікрофона, мобільна інтеграція, вставка в термінал. Модель займає ~1,5 ГБ RAM, вивантажується після 5 хв простою. Розбір Orca: артефакт «Голосовий ввід для Sigma T3» на старому акаунті.                                                                                                                                                                                                                                                      |
| **Щоденна синхронізація з T3 Code**                | Працює                      | Останній merge `6febcdbe` (upstream `1a4f3c4a`). Ще 1 коміт upstream (frontmatter у markdown-превʼю) прийде з наступною синхронізацією.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Дрібниці:

- Нове лого: суцільна Σ (на проді чорна на акцентному `#7C8CFF`), без графа з вузлами. iOS, web і Windows іконки перегенеровано на Mac. Три `*-macos-1024.png` ще старі: їх треба вручну експортувати з Icon Composer (macOS pre-Tahoe, див. `assets/README.md`), бо `ictool` не дає safe area.
- Гілку `claude/project-thread-bv1kxd` (дубль фіксу ліцензій) можна видалити.
- На Mac у `~/Documents/Projects/sigma-t3` є `git stash` «local pnpm-lock before pull 2026-10-26». Локальний pnpm v12 переписує `pnpm-lock.yaml`; ці зміни не комітимо (`git checkout pnpm-lock.yaml`).
- Відомі падіння, які є й на `main` або в чистому upstream і не блокують: knip на `AnalyticsService`, тест `CodexAuthCallback`, тест `PdfViewer` (падає і в upstream), кілька помилок typecheck у mobile.

## 5. Синхронізація з upstream T3

Повна процедура: [docs/operations/sigma-upstream-sync.md](operations/sigma-upstream-sync.md). Коротко, як це реально робиться:

- `origin` = `drenkas/sigma-t3`, `upstream` = `pingdotgg/t3code`.
- Upstream входить у `main` **лише звичайним merge-комітом**, ніколи squash чи rebase. Автор/комітер `Dmytro Renkas <25162167+drenkas@users.noreply.github.com>`.
- Робоча гілка `sigma-upstream/<upstream-sha>` від `origin/main`.
- Конфлікти розв'язуються на користь збереження фіч Sigma:
  - версії пакетів лишаються `0.1.0-preview.1` (server, desktop, web, contracts);
  - `"private": true` у `apps/server/package.json`;
  - ідентичність Sigma (назви, схеми, `~/.sigma-t3`, вимкнена телеметрія, порожній hosted Connect);
  - поля форку всередині схем upstream (team roles, `additionalWorkspaceRoots`, speech, `role` у субагентах): тримаємо обидві сторони;
  - міграції форку лише в `SigmaMigrations.ts`, ніколи в `Migrations.ts` upstream.
- Перевірки: `npx -y pnpm@12.14.0 install --frozen-lockfile`, `vp run typecheck` у кожному пакеті, `vp test run` на змінених тестових файлах. Upstream додав тест розміру контексту агента: при зміні цифр через team roles оновлюємо очікування під Sigma.
- **Правило власника від 24.10:** щоденна синхронізація не потребує PR. Чистий merge або конфлікти без відкритих питань і зелені перевірки → `git push origin HEAD:main` (тільки fast-forward). PR з питанням лише тоді, коли конфлікт ставить справжній вибір або merge ламає перевірку; такий PR власник зливає сам.
- У хмарі Claude Code `scripts/sigma-upstream-sync.mjs` не працює (`gh pr` потребує GraphQL), тому merge робиться звичайним git.

### Запланована задача

На старому акаунті є запланована задача «Щоденна синхронізація з T3 Code»: щодня о 07:47 за Варшавою (`CRON_TZ=Europe/Warsaw 47 7 * * *`), постійна сесія, без додаткових connectors. Її промпт:

```text
In drenkas/sigma-t3, check whether pingdotgg/t3code main has new commits not yet in origin/main (git merge-base --is-ancestor upstream/main origin/main). If nothing is new, report that in one line.

If there are new commits, merge upstream/main into a worktree branch sigma-upstream/<upstream-sha> created from origin/main, with an ordinary merge commit (author/committer Dmytro Renkas <25162167+drenkas@users.noreply.github.com>), per docs/operations/sigma-upstream-sync.md. scripts/sigma-upstream-sync.mjs does not work in the cloud environment (gh pr needs GraphQL, which is blocked), so do the merge with git directly. Resolve conflicts preserving Sigma features (keep Sigma's own package versions, "private": true on apps/server, Sigma identity). Install deps (npx -y pnpm@12.14.0 install --frozen-lockfile), run vp run typecheck in every app/package and vp test run on the test files the merge changed. Failures that also fail on pristine upstream or come from the container (no Electron binary, no IPv6, GIT_CONFIG insteadOf rewrites) are not blockers.

Standing rule from Dmytro (2026-10-24): the daily sync does not need a PR.
- If the merge is clean, or every conflict resolved without open questions, and checks pass: push the merge commit straight to main (git push origin HEAD:main, fast-forward only; never force, never squash, never rebase). Then post a short Ukrainian summary in the thread: commit count, upstream SHA, conflicts resolved, checks run.
- Only if a conflict raises a real question (both sides changed the same logic and choosing loses behavior) or a check fails because of the merge: push the branch, open a PR with a short Ukrainian summary and the open question, ask Dmytro in the thread, and do not merge it. He merges those himself, with a merge commit.
```

Була ще задача «Daily Pi version check for Sigma» для старого `drenkas/Sigma`; вона вже автоматично вимкнена й не потрібна.

## 6. Ухвалені рішення

- Форк зберігає історію upstream і внутрішні імена `@t3tools/*` та MCP; перейменовуємо лише видиме користувачу.
- Repository tasks видалено на користь проєктів на кілька папок (22.10).
- Моделі ролей задаються командою `/roles`, а не панеллю (22.10).
- Мобільний застосунок не змінюємо; з форком він працює через LAN/Tailscale.
- Hosted T3 Connect вимкнено як межу форку; повернення лежить в окремій гілці й чекає рішення.
- Постійних анімацій немає (правило upstream про GPU); у графі лише легкі переходи й пульс статусу.
- Дрібні зміни власник часто просить вливати в `main` напряму без PR («просто вмерж без pr»). PR відкриваємо, коли власник просить або є питання для огляду.
- GitHub Actions у форку вимкнено до окремого огляду. Публічних релізів, підпису Developer ID і нотаризації немає; preview збирається локально з ad-hoc підписом і без автооновлення.
- Відповіді власнику українською.

## 7. Локальне середовище власника (Mac)

| Шлях                                  | Що це                                                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `~/Documents/Projects/sigma-t3`       | Робоча копія `drenkas/sigma-t3`                                                                                       |
| `~/Documents/Projects/sigma-t3-build` | Окремий worktree, який створює й оновлює `sigma:preview-install` на `origin/main`                                     |
| `~/Documents/Projects/Sigma`          | Старий проєкт Sigma (саме цю папку було схвалено для доступу агентів з пристрою, на ній же запускався Remote Control) |
| `~/Documents/Projects/wim.wildix.com` | Робочий репозиторій власника, на якому перевіряли додаткові папки й pull                                              |
| `/Applications/Sigma T3.app`          | Встановлена preview-збірка                                                                                            |
| `~/.sigma-t3/userdata`                | Дані встановленої програми. Справжня база власника: не запускати на ній dev-сервер, не відкривати на запис            |
| `~/.sigma-t3/dev`                     | Дані dev-режиму (там зараз основні чати, див. розділ 4)                                                               |

Щоденний процес власника: закрити Sigma T3 → `cd ~/Documents/Projects/sigma-t3 && pnpm run sigma:preview-install` → відкрити Sigma T3 з Applications. Скрипт сам бере свіжий `origin/main`, ставить версію `0.1.0-preview.<дата-час>`, збирає ZIP (DMG на macOS 27 падає на `hdiutil`), перевіряє `codesign` і замінює застосунок (старий іде в Кошик). Агенти тестують свої зміни через `vp run dev` у власних worktree, щоб не заважати власнику.

Потрібен Node 24+, pnpm 12.

## 8. Що налаштувати на новому акаунті

1. **GitHub.** Підключити GitHub ([claude.ai/connect-github](https://claude.ai/connect-github)) і переконатися, що Claude GitHub App має доступ до `drenkas/sigma-t3` (і за потреби `drenkas/Sigma`). Якщо корпоративна організація обмежує сторонні репозиторії, особисті репо треба дозволити окремо.
2. **Проєкт.** Створити новий проєкт з репозиторіями `drenkas/sigma-t3` і `drenkas/Sigma`, вказати в інструкціях проєкту відповідати українською й читати `docs/HANDOFF.md`.
3. **Запланована задача.** Створити заново щоденну синхронізацію з промптом із розділу 5 (старі задачі не переносяться між акаунтами). Варто вимкнути стару, щоб два акаунти не синхронізували паралельно.
4. **Пристрій.** Підключити Mac у застосунку Claude і схвалити папки `~/Documents/Projects/sigma-t3` (головна) та, за потреби, `~/Documents/Projects/Sigma` і `~/Documents/Projects/wim.wildix.com`. Remote Control потрібен для збірок і команд на Mac.
5. **Артефакти й треди старого акаунта** (план переносу, ревʼю коду, розбір Orca, варіанти назви) на новому акаунті, ймовірно, не відкриються. Їхній суттєвий зміст перенесено сюди.
6. **Автор комітів** не змінюється: `Dmytro Renkas <25162167+drenkas@users.noreply.github.com>`, навіть з корпоративного акаунта.
7. Пам'ять проєкту на старому акаунті була вимкнена, тож усе, що треба знати, є в цьому файлі, `AGENTS.md` і `docs/operations/`.

## 9. Як почати наступному агенту

1. Прочитати `AGENTS.md`, `docs/operations/sigma-fork.md`, `docs/operations/sigma-upstream-sync.md` і цей файл.
2. Перевірити `git log origin/main` проти `upstream/main`, щоб знати, наскільки відстає синхронізація.
3. Спитати власника про відкриті пункти з розділу 4: перенесення чатів dev → userdata, злиття гілки з T3 Connect, результат тесту голосового вводу, і чи знімати паузу з плану (розділ 3).
4. Коли стан зміниться, оновити цей файл: переписати застарілі пункти, а не дописувати нові поверх.
