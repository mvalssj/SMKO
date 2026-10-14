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

## Controles

| Ação | Teclado | Controle |
|---|---|---|
| Acelerar | ↑ / W / X / Espaço | A / RT |
| Frear / ré | ↓ / S / Z | B / X / LT |
| Virar | ← → / A D | analógico / direcional |
| Derrapar | Shift / C | LB / RB |
| Usar item | E / Q / Ctrl (segure freio para jogar o casco para trás) | X / Y |
| Menus: confirmar / voltar | X, Espaço ou Enter / Z, Esc | A / B |
| Sair do treino | Esc | |

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
```

Estado atual: bot-test 20/20, cpu-test 160/160 CPUs terminam, item-test 13/13, net-test passando, lobby-test 15/15.
O bot usa a mesma IA das CPUs, inclusive o resgate do Lakitu; sem ele, em Bowser Castle 3 a IA erra os pulos entre
plataformas.

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
- **Som**: o driver de som do próprio jogo (código SPC700 e amostras da ROM, lista de envio em $82:8000; músicas
  por tema carregadas em $D000) roda num emulador de SPC700 + DSP escrito aqui (`src/audio`), num AudioWorklet.
  Portas: 0 = música, 1 = efeitos, 2/3 = motor. Tecla M liga/desliga.
- **Chegada e resultados**: número grande da posição (tabela de janelas HDMA, bloco 0x5E760, soma de cor), lista de
  chegada, quadro LAP TIME, telas RESULTS/STANDINGS remontadas da ROM, cerimônia de pódio (aproximada) e vidas no GP solo.
- **Battle Mode online**: 3 balões por jogador (gráficos da ROM); o servidor estoura e decide o vencedor.
- **Progresso local**: Special Cup e 150cc liberados com ouros em 100cc; recordes do Time Trial.
- **Online**: o servidor recusa movimentos impossíveis, outro jogador assume as CPUs se o anfitrião sair e quem
  entra no meio recebe os blocos quebrados.

## Aviso legal

Super Mario Kart é marca e propriedade da Nintendo. Este projeto não distribui ROM nem assets; use apenas um dump
do seu próprio cartucho. Não publique ROMs (o `.gitignore` já as exclui).
