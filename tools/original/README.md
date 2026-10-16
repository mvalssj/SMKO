# Medições no jogo original

Scripts de análise (não fazem parte do jogo) que rodam a **sua** ROM de Super Mario Kart (USA) no núcleo snes9x
em WebAssembly e gravam a memória do kart quadro a quadro. Foram usados para medir a física e os itens que estão em
`tools/ref/original-physics.json`, conferidos por `npx tsx tools/physics-fidelity-test.ts`.

O emulador não está no projeto. Baixe-o à parte, fora da pasta do jogo:

```bash
mkdir ../emu && cd ../emu && npm pack romdev-platform-snes@0.12.2 && tar xzf romdev-platform-snes-0.12.2.tgz
# núcleo: ../emu/package/wasm/snes9x_libretro.js
```

O núcleo não traz nenhum dado do chip DSP-1 e recusa a ROM original. Por isso a cópia da ROM que os scripts usam
(só em memória, nunca salva) diz no cabeçalho que não há coprocessador:

- `host.mjs` (`withoutDsp`): sem o chip, os menus, o HUD, os sprites e a velocidade funcionam, mas a perspectiva e
  o movimento não (o kart não sai do lugar).
- `dsp-host.mjs` + `dsp1.mjs` + `dsp1-ops.mjs`: cada acesso do jogo ao chip vira `COP` e é respondido daqui, com a
  matemática dos comandos do DSP-1 (multiplicação, rotação, distância exatas; projeção e câmera aproximadas, em
  ponto flutuante). Com isso o kart anda e as posições batem com as nossas (grid de largada idêntico), mas os
  sprites ainda não aparecem no lugar certo na tela. É lento: centenas de paradas por quadro.

| Script | O que grava |
|---|---|
| `record-speed.mjs <núcleo> <rom> <saída.json> <seleção> tt\|gp` | velocidade ($10EA): acelerar, soltar, acelerar, frear |
| `record-turn.mjs <núcleo> <rom> <saída.json> <seleção>` | direção ($102A), balanço ($10AA): curva, power slide, pulo |
| `record-item-speed.mjs <núcleo> <rom> <seleção> <item>` | velocidade com um item usado no time trial (`SERIES=1` imprime tudo) |
| `record-effects.mjs <núcleo> <rom> <item> <saída.json>` | toda a memória $0C00-$1FFF depois de usar o item (contadores dos efeitos) |
| `dsp-grid.mjs <núcleo> <rom>` | posições dos 8 karts no grid do GP (com o DSP-1 respondido daqui) |
| `dsp-objects.mjs <núcleo> <rom> <item> <quadros> <saída.json>` | um item lançado na largada: objetos ($1800-$1FFF, a cada $100; x em +$18, y em +$1C) e karts |
| `tt-start.mjs <núcleo> <rom> <copa> <pista>` | onde o kart larga no time trial |

A seleção é o caminho do cursor na tela de pilotos (TVs: Mario, Peach, Bowser, Koopa / Luigi, Yoshi, DK, Toad):
`""` Mario, `RR` Bowser, `RRR` Koopa, `DR` Yoshi. Os itens são os números do jogo, na ordem de `ITEM_KINDS`
(0 cogumelo, 1 pena, 2 estrela, 3 banana, 4 casco verde, 5 vermelho, 6 Boo, 7 moedas, 8 raio), postos na mão do
kart em `$0D70` com `$0D71 = $C0`.

O que já foi visto: a velocidade é 1/256 px por quadro (o kart anda exatamente isso com o DSP-1 respondido) e o
grid do GP no Mario Circuit 1 é igual ao nosso. No time trial o kart larga 16 px à frente da pole e um quarto do
caminho até a segunda fila (medido em 9 pistas; `tt-start` nas medições). No menu do time trial do original, a
copa se escolhe com ← e ↓ e a pista com → e ↓.

Cascos: andam 768 (3 px) por quadro mais a velocidade do kart que lançou (verde e vermelho, medido com o kart
parado e a 667). As batidas ainda não acontecem na análise: o jogo descarta os karts das CPUs da tela (não ficam
no OAM) com a projeção aproximada, e a colisão dos itens parece depender disso.

Com o DSP-1 respondido daqui (incluindo `ADC`/`SBC $6000`, que o jogo usa para somar as projeções às posições e
o `Raster`, que monta a perspectiva do chão no carregamento: 64 ângulos × 96 linhas da pista, 112 linhas do mapa),
o jogo original desenha pista, mapa e sprites. O mapa sai igual ao nosso. Na pista, o original desenha os karts
maiores e as marcas do chão mais espaçadas do que a mesma geometria no nosso jogo: alguma convenção de como o jogo
usa os números do chip (linha onde começa a tabela do chão, escala M que escolhe o tamanho dos sprites) ainda não
está certa na emulação; sem o chip verdadeiro não dá para decidir.

Com os sprites projetados, os itens acertam na análise: um casco verde da largada acerta a CPU parada à frente
(`dsp-objects.mjs <núcleo> <rom> 4 150 saída.json`). Uma banana mudada de lugar direto na memória não acerta (outros
dados do objeto não acompanham); a escorregada na banana ainda não foi medida.

Caixas de item (`box-tile-writer.mjs <núcleo> <rom>`): a caixa é um bloco do mapa da pista em `$7F:0000`; um
watchpoint de escrita nele mostra a rotina que pega a caixa (`$C1:B762`, troca o bloco pelo de caixa usada pela
tabela em `$C1:B72B` e soma 1 em `$1EB4`) e a que as devolve (`$C1:BECA`: quando `$1EB4` chega a 30, todas as caixas
pegas, guardadas em `$7F:DF80`, voltam e a conta zera). Não há volta por tempo.
