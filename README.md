# SMKO — Super Mario Kart online (web, até 8 jogadores)

Remake web do Super Mario Kart (SNES) com multiplayer online. O jogo **não inclui nada da Nintendo**:
cada jogador escolhe a própria ROM no navegador, e pistas, gráficos e terreno são extraídos dela localmente.
A ROM nunca é enviada ao servidor; o servidor só compara o CRC32 para garantir que todos usam a mesma versão.

## Rodar

```bash
npm install
npm run dev        # servidor (porta 3077) + Vite (porta 5173) com hot reload
```

Abra http://localhost:5173 e escolha a ROM **americana** (`.sfc`/`.smc`). O jogo abre na tela de título original:

- **1P GAME** → MARIOKART GP (cilindrada 50/100/150cc → seleção de piloto → copa: 5 corridas contra 7 CPUs, com a
  pontuação original 9/6/3/1) ou TIME TRIAL (sozinho, sem itens → copa → pista).
- **ONLINE GAME** → CREATE ROOM (escolhe a cilindrada e cria a sala) ou JOIN ROOM (digita o código de 5 letras, ou abre o
  link de convite). Na seleção de piloto todos veem o cursor de todos ao vivo (1P…8P sobre as TVs, piscando enquanto
  escolhe, fixo depois do "OK"); um piloto confirmado não pode ser pego por outro. O anfitrião escolhe a copa e continua
  vendo quem está na sala ("3P 2 OK"): **START** = Grand Prix das 5 pistas, **B** = escolher uma pista avulsa. Quem não
  confirmou fica com o piloto do cursor (ou o primeiro livre). As vagas são completadas com CPUs.
- **Link de convite** (`?sala=CÓDIGO`, botão "copiar link"): abre direto na sala. Se ela está no lobby, cai na seleção de
  piloto; se uma corrida está rolando, entra **assistindo** (câmera atrás de um kart, ← → troca) e corre a partir da
  próxima corrida do GP, no lugar de uma CPU (ou quando a sala voltar ao lobby).

Produção (um único processo servindo o jogo e o WebSocket):

```bash
npm run build
npm start          # http://localhost:3077  (PORT=xxxx para mudar)
```

Para jogar pela internet, publique em um VPS (Node 22+) atrás de HTTPS, ou exponha a porta local com um túnel
(`cloudflared tunnel --url http://localhost:3077`). O cliente usa `wss://` automaticamente quando a página está em HTTPS.

### Painel do administrador

O servidor tem um painel em `/admin` (em desenvolvimento, `http://localhost:5173/admin`). Ele só funciona com uma
senha definida:

```bash
SMKO_ADMIN_PASSWORD=uma-senha-forte npm start
```

| Variável | Para quê |
| --- | --- |
| `SMKO_ADMIN_PASSWORD` | Senha do painel. Sem ela o painel fica desligado. |
| `SMKO_DATA_DIR` | Pasta das configurações, banimentos e estatísticas (padrão: `data/`, fora do Git). |
| `SMKO_TRUST_PROXY=1` | Atrás de um proxy (nginx, Cloudflare, Render...): usa o IP do cabeçalho `X-Forwarded-For`. |

O que ele mostra e permite:

- **Geral**: jogadores online, picos do dia e da semana, salas por modo, quem está no menu, no lobby, correndo ou
  assistindo; CPU, memória, mensagens e banda por segundo, tempo do ciclo de atualização e do event loop, com
  gráficos dos últimos 5 minutos.
- **Salas**: cada sala (modo, pista, cc, corrida do GP, pessoas, bots, espectadores) e cada partida de Battle Royale
  (vivos, pessoas e bots, fase da zona, quem roda os bots com o FPS e o ping dele). Mapa ao vivo das posições,
  encerrar, expulsar alguém, e assistir uma sala no jogo.
- **Jogadores**: piloto, onde está, ping, tempo conectado, se roda os bots, FPS, aparelho (celular, controle, 16:9),
  reconexões, mensagens atrasadas, avisos. O IP aparece mascarado (`189.45.x.x`) com um código que identifica o
  endereço para banimentos sem revelá-lo.
- **Moderação**: avisos do anti-trapaça (velocidade impossível, item usado sem ter, mensagens fora de hora ou sem
  permissão), banimentos com motivo e prazo, e o registro de tudo o que o administrador fez. Com a expulsão
  automática ligada, quem junta muitos avisos em 10 minutos é desconectado.
- **Estatísticas** (SQLite em `data/stats.db`, pelo `node:sqlite` do Node 22.5+; em versões antigas, só em memória):
  partidas por dia e por modo, duração média, pistas e pilotos mais escolhidos, vitórias de pessoas e de bots no
  Battle Royale, onde a zona fecha, sobrevivência média, quedas dos bots por pista, aparelhos e FPS médio, pico de
  jogadores por dia. Os navegadores mandam a cada 30 s só o FPS, o tipo de aparelho e controle e a tela larga.
- **Configurações** (valem na hora, sem reiniciar): ligar e desligar modos, limites de salas, de pessoas por sala,
  de partidas e de pessoas por Battle Royale, velocidade da zona, expulsão automática, e um aviso que aparece na
  tela de todos os jogadores.

O painel continua sem nenhum dado da ROM.

## Controles

O controle (gamepad) segue as posições do SNES: o botão de baixo é o B, o da direita é o A, o da esquerda é o Y e o de cima é o X. No Xbox isso corresponde a A, B, X e Y; no PlayStation, a ✕, ○, □ e △. Basta conectar o controle e apertar um botão; aparece um aviso de "Controle conectado".

| Ação | Teclado | Controle | Tela de toque |
|---|---|---|---|
| Acelerar | ↑ / W / X / Espaço | B (baixo) / RT | B |
| Frear / ré | ↓ / S / Z | Y (esquerda) / LT | Y |
| Virar | ← → / A D | analógico / direcional | direcional |
| Derrapar / pular | Shift / C | L / R | L / R |
| Usar item | E / Q / Ctrl (segure freio para jogar o casco para trás) | A / X | A / X |
| Menus: confirmar / voltar | X, Espaço ou Enter / Z, Esc | B ou Start / Y | B ou START / Y |
| Sair do treino | Esc | | |

**Celular e tablet:** em telas de toque aparece um controle do SNES na tela. Dá para deslizar o dedo de um botão para outro, como do B para o A. Em pé (retrato), o jogo fica em cima e os botões embaixo. Deitado (paisagem), os botões ficam semitransparentes sobre os cantos. O botão "tela cheia" também tenta virar a tela para paisagem.

**Sem o mapa:** a tecla **M** (ou o Select do controle, ou o botão "▤ sem mapa" no canto) esconde o mapa de baixo e a corrida ocupa a tela toda. A escala é a mesma, então os sprites continuam 1:1: o céu e o HUD descem 32 linhas e a câmera sobe um pouco (de 20 para 38), o que deixa o kart perto da base da tela, como no original, e mostra mais da pista à frente. Aperte M de novo para o mapa voltar. A escolha fica salva no navegador. O som passou para a tecla **N**.

**Tela larga (16:9):** o botão "▭ 16:9" no canto aumenta a imagem da corrida de 256 para 348 colunas, mantendo os pixels 8:7 do SNES. A imagem não é esticada: aparece mais pista dos lados, e o HUD e o mapa continuam nas posições originais. Os menus e os quadros de resultado continuam em 4:3. A escolha fica salva no navegador.

## Estrutura

```
src/rom/        leitura da ROM: descompressão, tiles, paletas, terreno, overlays, largada, linha de chegada, IA
src/game/       física (60 Hz), renderização Mode 7 (WebGL), corrida/HUD, input
src/net/        cliente WebSocket + interpolação dos karts remotos
shared/         protocolo cliente/servidor
server/         salas, largada, retransmissão de estado, chegada e resultados
tools/          ferramentas de desenvolvimento (não vão para o jogo)
```

O formato dos dados da ROM segue a documentação do editor [Epic Edit](https://github.com/thomasgoldstein/epicedit) (GPL-3);
o código aqui é uma implementação própria em TypeScript.

## Ferramentas de verificação

```bash
npm run dump-track -- "Super Mario Kart (USA).sfc" track-dump   # PNG de todas as pistas
npx tsx tools/bot-test.ts "Super Mario Kart (USA).sfc"          # bot completa 5 voltas em cada pista GP
npx tsx tools/cpu-test.ts "Super Mario Kart (USA).sfc"         # 8 CPUs juntas em cada pista
npx tsx tools/item-test.ts "Super Mario Kart (USA).sfc"        # regras de itens + física dos cascos
npm start & npx tsx tools/net-test.ts "Super Mario Kart (USA).sfc" 8 0     # 8 clientes online com itens
npm start & npx tsx tools/net-test.ts "Super Mario Kart (USA).sfc" 3 0 1   # 3 clientes + 5 CPUs do anfitrião
npm start & npx tsx tools/lobby-test.ts "Super Mario Kart (USA).sfc"      # lobby ao vivo + espectador entrando no meio
npx tsx tools/race-preview.ts "Super Mario Kart (USA).sfc" saida 0 3       # tela da corrida (software) com o bot dirigindo
npx tsx tools/hud-preview.ts "Super Mario Kart (USA).sfc" saida            # HUD e Lakitu (largada, voltas, chegada...)
npx tsx tools/royale-test.ts "Super Mario Kart (USA).sfc"                  # Battle Royale: mundo, zona e 99 bots
npm start & npx tsx tools/royale-net-test.ts "Super Mario Kart (USA).sfc" # Battle Royale online: troca bot -> pessoa
SMKO_ADMIN_PASSWORD=teste123 SMKO_TRUST_PROXY=1 npm start & npx tsx tools/admin-test.ts "Super Mario Kart (USA).sfc" teste123  # painel
```

Estado atual: bot-test 20/20, cpu-test 160/160 CPUs terminam, item-test 13/13, net-test passando, lobby-test 15/15.
O bot usa a mesma IA das CPUs, inclusive o resgate do Lakitu; sem ele, em Bowser Castle 3 a IA erra os pulos entre
plataformas.

## Battle Royale (modo novo)

No menu principal: **BATTLE ROYALE**. São 100 pilotos num mundo aberto que junta todas as pistas do jogo: as 20 do GP e as 4 de batalha. Vence o último que ainda tiver balões.

- **O mundo é um planetinha:** não tem borda. Quem sai pela direita volta pela esquerda, e quem sai por cima volta por baixo, como num planeta.
  - O chão faz a curva do Animal Crossing: ao longe ele cai, o horizonte fica um pouco mais baixo e perto, e os karts surgem subindo por ele conforme você se aproxima. O botão **◠ curvo / ▬ plano**, no canto da tela, deixa o chão plano como no SNES (a escolha fica salva).
  - Distâncias, mira dos cascos, bots, zona, colisões e a rede contam sempre o caminho mais curto, atravessando a borda se for o caso. A zona também pode ficar em cima da emenda.
  - As faixas das quatro bordas se juntam com as do outro lado e formam mais um espaço entre pistas, que segue a mesma regra das regiões: chão da região ou estrada.
- **As regiões:** a grade de 6 × 4 pistas é agrupada em 8 regiões pelo tipo de terreno:
  ```
  GELO   GELO   GELO  │ FANTASMA FANTASMA FANTASMA
  DONUT  DONUT  MARIO   MARIO    MARIO   CASTELO
  DONUT  DONUT  MARIO   MARIO   CASTELO  CASTELO
  PRAIA  PRAIA  PRAIA │ CHOCO    CHOCO   RAINBOW
  ```
  - Dentro de uma região as pistas ficam coladas, sem fronteira: o espaço entre elas é preenchido com o chão da própria região (grama, neve, chocolate, areia do Mario Circuit) e as cercas da borda são retiradas.
  - Onde o chão da região é vazio, lava ou mar fundo (Ghost Valley, Bowser Castle, Koopa Beach), uma ponte com o piso das próprias pistas (tábuas, tijolos, areia) passa pelo meio do espaço entre elas.
  - Entre regiões diferentes, e só ali, ficam as estradas no estilo do Mario Circuit (asfalto listrado e bordas copiados das retas do Mario Circuit 1 e 2), como o rejunte entre azulejos, com cruzamentos de asfalto.
  - De cada lado de cada pista sai uma entrada que abre a cerca e vai até o traçado, atravessando o que houver no caminho: canos, vazio, água, lava. Vinda da estrada, é de asfalto; vinda da própria região, é do piso da pista.
  - Os últimos círculos da zona evitam as regiões mortais (Ghost Valley, Bowser Castle e Rainbow Road).
  - O verde de fora das cercas, que na pista original é "fora dos limites", vira grama transitável.
  - Cada pista mantém seus blocos, terreno, objetos (canos, Thwomps, toupeiras, plantas, peixes), caixas de item e moedas.
  - O céu do horizonte e a música mudam conforme a pista em que você está.
- **As regras:**
  - São as do Battle Mode: 3 balões, e cada acerto de casco, banana ou estrela fura um.
  - Uma área segura vai fechando em 6 fases, e o chão fora dela fica arroxeado.
  - Fora da área, o Lakitu mostra a placa de contramão e você perde um balão a cada 4 s.
  - O contador de pilotos vivos fica no lugar das vidas do GP. Quem perde todos os balões assiste aos outros (← → troca de piloto).
- **Os bots:**
  - Dentro de uma pista, seguem a linha de corrida da própria ROM, os mesmos dados de IA das CPUs.
  - Entre pistas e para entrar na área segura, usam um mapa de distâncias do mundo inteiro.
  - Pegam caixas de item e usam os itens como os jogadores: cascos em quem está à frente, banana em quem vem atrás, estrela para atropelar.
  - Quando caem, o Lakitu os devolve ao ponto mais próximo da linha de corrida.
- **Online:** ao escolher BATTLE ROYALE, o jogo procura uma partida no servidor. A partida tem sempre 100 pilotos.
  - Se houver uma em andamento, você entra no lugar de um bot que ainda está vivo: assume o kart, a posição e os balões dele, de preferência dentro da área segura e longe das outras pessoas. Isso vale até a 3ª fase da zona.
  - Se não houver, começa uma partida nova com você e 99 bots.
  - Os bots rodam no navegador de um dos jogadores. Se ele sair, outro assume do ponto em que estavam.
  - O servidor cuida dos itens, dos balões e da zona, e continua sem ver a ROM.
  - Cada jogador recebe os karts próximos 20 vezes por segundo e os distantes 4 vezes por segundo.
- **Sem servidor:** você e 99 bots, tudo no navegador.

Teste: `npx tsx tools/royale-test.ts "Super Mario Kart (USA).sfc"`. Ele confere que todas as pistas estão ligadas, que um kart atravessa a borda do mundo pela estrada e volta do outro lado, que distâncias e zona contam o caminho mais curto, que a zona fecha dentro do mundo (e quase nunca no vazio ou na lava) e que os bots andam e caem pouco.

## O que já funciona

- Leitura da ROM (US/JP/EU, com ou sem cabeçalho de 512 bytes) e das 20 pistas GP
- Tela da corrida 1P como a original (256×224, medida no jogo): faixa do céu nas linhas 3–23, pista em Mode 7 nas
  linhas 24–106 (horizonte na 24, rodas do seu kart na 101), faixa preta e o mapa do circuito inclinado embaixo
  (linhas 115–218) com as cabeças dos pilotos
- HUD original desenhado com os tiles da ROM: caixa da volta e cronômetro na faixa do céu, moedas e a posição grande
  na pista, item no topo
- Lakitu com os sprites da ROM: largada com o semáforo (desce, acende vermelho/vermelho/verde a cada 65 quadros,
  sobe — trajetória medida quadro a quadro), placas "LAP 2/3/4" e "FINAL LAP", bandeira na chegada, placa de
  contramão e o resgate quando você cai
- Pilotos desenhados 1:1 em pixels do SNES, escolhendo o tamanho desenhado à mão mais próximo (sem esticar)
- Mode 7 em WebGL, com o tile de preenchimento fora do mapa como no SNES
- Fundo com parallax de cada tema (duas camadas que giram com a câmera) e céu na cor original
- Os 8 pilotos com os sprites da ROM: 16 ângulos (espelhados para o outro lado) × 11 tamanhos desenhados à mão,
  com as paletas do tema da pista; escolha de personagem no lobby (um por jogador na sala)
- Terreno real de cada tile: grama/areia/lama lentas, gelo escorregadio, zippers, óleo, rampas, lombadas,
  lava/água/vazio (queda e respawn), blocos quebráveis (cercas do Ghost Valley, gelo do Vanilla Lake)
- Overlays da pista (caixas de item, moedas, zippers)
- Contagem de voltas à prova de "vai e volta" na linha, posição na corrida pelas áreas da IA do próprio jogo
- Salas de até 8 jogadores, grid aleatório, contagem regressiva, ranking ao vivo, resultado final, minimapa
- Objetos da pista: canos, Thwomps (sobem e esmagam), toupeiras, plantas piranha, peixes saltando, com os sprites e
  posições da ROM e animação sincronizada pelo relógio da corrida
- Itens: caixas (somem e voltam em 10 s), moedas (até 10, cada uma aumenta um pouco a velocidade máxima),
  cogumelo, pena, estrela, banana, casco verde (quica), casco vermelho (persegue quem está à frente), Boo (rouba o
  item de alguém e deixa você transparente), raio (encolhe os outros). Chances originais da ROM por pista e posição.
  O servidor é a autoridade: sorteia, controla caixas/moedas/projéteis e confirma os acertos
- CPUs: completam as vagas online (simuladas pelo navegador do anfitrião) ou correm contra você no treino solo;
  usam as áreas de IA da ROM, desviam de canos, soltam bananas, têm "elástico" de velocidade e são resgatadas pelo
  Lakitu se ficarem perdidas

## Próximas fases

1. Telas de resultado e classificação do GP no estilo original (hoje são HTML), sons e músicas (o SPC da ROM),
   animações dos pilotos (giro, queda). A perspectiva exata do Mode 7 e do mapa de baixo é calculada pelo DSP-1 no
   original e foi aproximada (a análise roda sem o chip)
2. **Física fiel**: extrair do código 65816 (REA + Ghidra) aceleração, curva, derrapagem e pulo de cada
   personagem, e validar contra o jogo original. Hoje as constantes são aproximadas, inclusive o "voo"
   ao sair de uma borda em alta velocidade (usado para atravessar a ponte quebrada do Donut Plains 3)
3. Itens especiais das CPUs como no original (cada personagem tem o seu) e quadros reais de casco girando
4. **Servidor autoritativo**: hoje cada cliente simula o próprio kart e o servidor só valida limites
   (posição, voltas, tempo mínimo). Para competição séria, a física deve rodar no servidor
5. Modo Battle (balões), copas com pontuação
6. Se o anfitrião sair no meio da corrida, as CPUs param: passar a simulação para outro jogador

## Telas originais (título, menus, seleção de piloto e de copa)

As telas são desenhadas por um mini-PPU de SNES (`src/snes/ppu.ts`: modos 0 e 1, tiles 8x8, sprites, janela) a partir
dos blocos da ROM, na resolução original 256x224. Ele foi validado pixel a pixel contra o snes9x: **100% idêntico** no
título, na seleção de piloto, no "1P OK?" e na seleção de copa.

Como os dados foram encontrados (US): rodamos a ROM no núcleo snes9x em WebAssembly (pacote `romdev-platform-snes`,
só na análise, não faz parte do jogo), com uma cópia em memória sem o chip DSP-1 (os menus não usam), capturando
VRAM/CGRAM/OAM/registradores em cada tela e rastreando cada byte de volta à ROM:

| Tela | Origem |
|---|---|
| Título | bloco comprimido 0x71996: tiles + mapas na ordem da VRAM (0x0000–0x37FF) e as 16 paletas em +0x4000 |
| Fonte/cursor dos menus (sprites) | bloco 0x70000, 2bpp expandido para 4bpp em VRAM 0x8000 |
| Seleção de piloto | bloco 0x70B29: mapas BG1/2/3 em +0x0000/+0x0800/+0x1800, tiles em +0x2A00, paletas em +0x2800 |
| Seleção de copa | tiles 2bpp de 0x70B29+0x3900 e 0x70000+0x200; paletas em 0x70B29+0x3700; mapa montado pelo código |
| Pontos do GP | 0x5BEB4: 9, 6, 3, 1, 0… |

A caixa preta dos menus é a janela 1 do PPU escondendo BG1/BG2 sobre um BG3 preto; os textos são sprites (dígitos
0x00–0x09, letras 0x0A–0x23); a fonte grande das copas usa 2 tiles por letra (0x80 + 2×índice).

## Tela da corrida (HUD, Lakitu, mapa)

Medida da mesma forma, numa corrida do jogo rodando no snes9x (sem o DSP-1 a pista sai errada, mas os sprites, o HUD
e a divisão da tela são os reais). `src/rom/race-gfx.ts` monta a VRAM de sprites igual à do jogo (conferida byte a byte):

| Gráfico | Origem |
|---|---|
| Fumaça, faíscas (tiles 00–3F) | bloco 0x00903 |
| Lakitu, nuvem, moedas, placas LAP/FINAL LAP, dígitos, bandeira, contramão (40–BF) | bloco 0x10000 +0x200 |
| Sombra do Lakitu (EB–ED), lâmpadas do semáforo (FB–FF) | bloco 0x10000 +0x120 / +0x180 |
| Cabeças do mapa e números de posição (120–15B) | bloco 0x30000 +0x800 / +0xC80 |
| Fonte do cronômetro, caixa da volta, ícones (BG3 2bpp, tile 0x80+) | bloco 0x112F8 |

As paletas dos sprites são as da pista (iguais à CGRAM do jogo); as do HUD (branco, azul-claro, preto) o jogo troca no
meio do quadro. A largada: o Lakitu aparece 306 quadros antes do verde, primeira luz vermelha em −130, segunda em −65,
verde em 0, e sobe acelerando a partir de +66. O "8" grande da posição é aproximado (não está na VRAM de sprites).

## Mapeamento da ROM (sprites)

As tabelas dos pilotos foram mapeadas na ROM americana e ainda não nas versões JP/EU, que usam o kart desenhado
como reserva:
- Folhas 4bpp (16 tiles de largura) em 0x02000 (Mario/Luigi), 0x12000 (Bowser), 0x22000 (Peach), 0x32000 (DK Jr.),
  0x42000 (Yoshi), 0x52000 (Koopa), 0x62000 (Toad)
- 0x9090: 11 distâncias × 16 ângulos, 2 bytes cada (quadro×2, flags de tamanho: nibble alto = largura/4,
  nibble baixo = altura/8; 0x44 = metade de um quadro simétrico 32×32)
- 0x91FA: endereço de cada quadro dentro da folha
- Paletas de sprite 8–11 do tema: Bowser/Yoshi 8, Mario/Toad 9, Luigi/Koopa 10, Peach/DK Jr. 11

## Física, som, resultados e Battle Mode (medidos no jogo original)

- **Física por personagem**: velocidade ($10EA), direção ($102A), derrapagem ($10AA) e mini-turbo ($10CA)
  medidos quadro a quadro no snes9x para as 4 classes (Mario/Luigi, Bowser/DK, Peach/Yoshi, Koopa/Toad):
  aceleração, velocidade máxima por cilindrada, fora da pista, moedas (+8 cada), freio, virada, power slide,
  hop (17 quadros), mini-turbo e largada turbo (janela de 8 quadros ao acender a 1ª luz). 1 unidade = 1/256 px/quadro.
- **Física conferida contra o original** (`npx tsx tools/physics-fidelity-test.ts`, sem ROM): os mesmos comandos do
  controle dados ao nosso kart e ao do jogo, comparados quadro a quadro com as gravações do original em
  `tools/ref/original-physics.json` (só números medidos). Velocidade máxima = tabela do jogo (ROM 0x18000: 912, 944,
  880, 864); cilindradas do código do jogo (`$C1:F026`: 50cc −128, 150cc +160); soltar o acelerador perde 10/8/6/4
  e frear 12/9/7/4 por quadro conforme a faixa de velocidade; a curva desfaz 14/17/16/18 por quadro ao soltar; a
  carroceria começa a balançar no 5º/2º/2º/3º quadro da curva e treme um passo para cada lado como no original; o
  kart responde ao controle um quadro depois, como o jogo (lido no retraço vertical).
- **Itens medidos no original** (o item colocado na mão do kart, `$0D70`, e usado; no mesmo teste): cogumelo
  empurra +50 por quadro além da aceleração do kart por 33 quadros, até 2016 (cerca de 8 px por quadro; Bowser/DK
  e Peach/Yoshi passam um pouco disso nos 2 últimos quadros no original, o que ainda não é reproduzido); acima da
  velocidade máxima o kart perde no máximo 56 por quadro; estrela dura 512 quadros e leva qualquer kart a
  1280–1314; pena é um arco de 36 quadros e 16 px; Boo deixa o kart invisível por 1152 quadros (medido em 8º
  lugar); o raio deixa os outros pequenos por 157 quadros. Ainda não medidos: rodada (banana/casco), cascos,
  caixas de item e o item especial de cada CPU. Soltando o acelerador acima da velocidade máxima, só vale a desaceleração normal (16 por quadro acima de 1024).
  Os scripts de medição (emulador à parte, com o DSP-1 respondido pela matemática dos comandos) estão em `tools/original/`.
- **Som**: o driver de som do próprio jogo (código SPC700 e amostras da ROM, lista de envio em $82:8000; músicas
  por tema carregadas em $D000) roda num emulador de SPC700 + DSP escrito aqui (`src/audio`), num AudioWorklet.
  Portas: 0 = música, 1 = efeitos, 2/3 = motor. Tecla N liga/desliga.
- **Chegada e resultados**: número grande da posição (tabela de janelas HDMA, bloco 0x5E760, soma de cor), lista de
  chegada, quadro LAP TIME, telas RESULTS/STANDINGS remontadas da ROM, cerimônia de pódio (aproximada) e vidas no GP solo.
- **Battle Mode online**: 3 balões por jogador (gráficos da ROM); o servidor estoura e decide o vencedor.
- **Progresso local**: Special Cup e 150cc liberados com ouros em 100cc; recordes do Time Trial.
- **Online**: o servidor recusa movimentos impossíveis, outro jogador assume as CPUs se o anfitrião sair e quem
  entra no meio recebe os blocos quebrados.

## Aviso legal

Super Mario Kart é marca e propriedade da Nintendo. Este projeto não distribui ROM nem assets; use apenas um dump
do seu próprio cartucho. Não publique ROMs (o `.gitignore` já as exclui).
