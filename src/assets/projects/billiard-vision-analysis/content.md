# Programmation pour ingénieurs  
**Rapport de projet : Billard**  
Nevò Mirzai Hamadani 328344 • Teo Halevi 329561  

---

## Vue d’ensemble

Ce projet met en place une chaîne complète d’analyse d’une partie de billard à partir d’images:

- **LabVIEW** pilote tout le flux de données (lecture d’images, conversion en pixmap, appels au C et à MATLAB).
- **C** (`Pix2Pos.c` / `Pix2Pos.exe`) détecte les boules dans chaque image et calcule leur score colorimétrique.
- **MATLAB** génère une feuille de score graphique (`ScoreSheetTx.pdf`) et décide si la partie est gagnée ou non.

L’utilisateur choisit une séquence dans l’interface LabVIEW, éventuellement coche *Create Matlab score sheet*, et le système :

1. Parcourt toutes les images `*.png` d’un dossier.
2. Convertit chaque image en `pixmap.bin`.
3. Lance `Pix2Pos.exe` pour extraire positions et scores (`Pos.txt`).
4. Optionnellement crée le script `AnalyseTx.m` et le PDF `ScoreSheetTx.pdf`.

---

## Organisation des fichiers

### C

Les fichiers C assurent la **robustesse** (gestion d’erreurs) et la **détection des boules** dans un pixmap binaire.

Quelques fonctions clés (toutes préfixées par `Error*` / `Warn*` / utilitaires) :

- `ErrorFreadNbEOF`  
  Vérifie les erreurs de lecture avec `fread` (EOF, lecture incomplète…) et quitte avec un code d’erreur sur `stderr`.

- `ErrorDim_width_height`  
  Vérifie que largeur et hauteur de l’image sont dans l’intervalle attendu ; quitte le programme si hors bornes.

- `ErrorNbElements_commandline`, `ErrorBounds_commandline`  
  Valident le nombre d’arguments de la ligne de commande et les limites (dimensions, intervalles RGB).

- `ErrorCalloc`  
  Vérifie que `calloc` n’a pas retourné `NULL` (allocation dynamique du pixmap).

- `ErrorFile_read_write`  
  Vérifie que les fichiers d’entrée/sortie existent et sont accessibles.

- `ErrorNbElementsInPM`  
  Vérifie si le nombre de pixels lus dans le pixmap est correct (erreur si trop peu, warning si trop).

- `WarnNoBallFound`  
  Signale le cas où aucune boule n’a été trouvée pour une couleur donnée.

- `CommandLine_ConvertToInt`  
  Convertit les arguments de la ligne de commande en `int` via `strtol` (gestion d’`errno` en cas d’erreur).

- `ReadPixmap`  
  Lit le fichier pixmap binaire et renvoie une structure contenant largeur, hauteur et tableau de pixels.

- `pixel_to_rgb`, `is_a_pixel_in_color_range`  
  Convertissent un entier “pixel” en composantes R/G/B et testent l’appartenance à une plage de couleur.

- `group_pixel_in_color_range`, `find_balls`  
  Parcourent l’image par carrés de taille boule (13×13 pixels), comptent les pixels dans les bons intervalles de couleur (rouge, jaune, blanc) et retournent score et position de chaque boule.

- `write_pos_score`  
  Écrit dans `Pos.txt` les lignes :  
  `Red: Xr, Yr, scorer`  
  `Yellow: Xy, Yy, scorey`  
  `White: Xw, Yw, scorew`.

Un score est considéré valide s’il dépasse `BallMinScore` (15). Sinon, la boule est marquée absente : coordonnées `-1`, score `0`.  
Toutes les allocations sont libérées (Valgrind: *All heap blocks were freed -- no leaks are possible*).

> **Important :** chaque exécution de `Pix2Pos.exe` traite **une seule** image/pixmap. Pour une séquence, LabVIEW le rappelle pour chaque image.

---

### MATLAB

Les fonctions MATLAB opèrent sur les coordonnées des 3 boules (rouge, jaune, blanche) pour analyser la partie et générer une feuille de score.

Fonctions principales :

- `GetBallMoveOrder`  
  Détermine quelle boule a bougé et dans quel ordre.

- `GetBallPathLength`  
  Calcule la longueur de la trajectoire d’une boule (en pixels) à partir de ses coordonnées `(X, Y)`.

- `GetFirstMoveIdx`  
  Donne l’indice du premier mouvement significatif d’une boule (distance au point initial > `MoveDistPx`).

- `GetFrame`  
  Calcule le cadre minimal (min/max en X et Y) entourant toutes les trajectoires des boules.

- `GetTouchIdx`  
  Repère les impacts “balle-bande” (contacts avec le cadre) à partir de `GetTouchPartialIdx`.

- `InterpolateNan`  
  Remplace les éventuels `NaN` dans les séries de coordonnées par la valeur suivante.

- `RemoveOutlier`  
  Détecte des points aberrants dans X et Y et les remplace par la valeur précédente.

- `Win`  
  Vérifie les conditions de victoire:  
  - les 3 boules ont bougé,  
  - la première boule a touché les bandes au moins 3 fois entre 2 chocs.

Le script principal `AnalyseTx.m` (créé automatiquement par LabVIEW):

- reconstruit le cadre intérieur du billard à partir des coordonnées,  
- trace la trajectoire des 3 boules (blanche en bleu, jaune en jaune, rouge en rouge),  
- affiche pour chaque boule la distance parcourue, combien de boules ont bougé, et combien de bandes ont été touchées,  
- écrit le PDF `ScoreSheetTx.pdf`.

---

### LabVIEW

Les VIs LabVIEW assurent la **lecture des images**, la **détection des bornes du billard**, les **appels au C** et la **génération du script MATLAB**.

Quelques SubVIs importants :

- `Trouver_bornes`  
  Cherche les limites intérieures du billard en détectant les pixels “DarkBlue” (bord) à l’aide de `Choose_left` et `Choose_right_bottom`.

- `Choose_left`, `Choose_right_bottom`  
  Met à jour les bornes haut/bas/gauche/droite si le pixel testé est dans l’intervalle de couleur et plus extrême que la valeur courante.

- `display_image`  
  Ouvre et affiche une image (chemin en entrée).

- `open_image`  
  Ouvre l’image et retourne largeur, hauteur et pixmap (1D).

- `write_pixmap`  
  Crée `pixmap.bin` (little-endian) à partir (width, height, pixmap).

- `Appel_programme_C`  
  Construit la ligne de commande de `Pix2Pos.exe` à partir des constantes de couleurs et des bornes trouvées, puis l’exécute via `System Exec`. Combine `stderr` et le fil d’erreur LabVIEW.

- `lecture_pos`  
  Lit `Pos.txt` et en renvoie le contenu texte.

- `score_to_nan` / `pos_to_nan`  
  Si le score d’une boule vaut 0, remplace ses coordonnées par `NaN`.

- `coord_array_to_string`  
  Convertit les tableaux `Xr, Yr, Xy, Yy, Xw, Yw` en chaînes pour les passer à MATLAB.

- `matlab_param_empty`, `matlab_script_strings`  
  Vérifient les paramètres d’affichage (types de lignes, symboles, couleurs) et construisent les chaînes constituant le script MATLAB `AnalyseTx.m`.

Le VI principal `Billard2023.vi` :

1. Utilise `Trouver_bornes` sur la première image pour définir les limites intérieures du billard.
2. Boucle sur toutes les images de la séquence :
   - `display_image` puis `write_pixmap` → `pixmap.bin`
   - `Appel_programme_C` → exécute `Pix2Pos.exe` et produit `Pos.txt`
   - `lecture_pos` lit les coordonnées/scores
3. Transforme les scores nuls en `NaN` pour les coordonnées correspondantes.
4. Si l’option MATLAB est activée:
   - Passe tous les vecteurs de coordonnées à `coord_array_to_string`,
   - Assemble les options d’affichage (couleurs, type de ligne, marqueurs),
   - Génère `AnalyseTx.m` via `matlab_script_strings`,
   - MATLAB crée `ScoreSheetTx.pdf`.

---

## Gestion des erreurs

### C

Les codes d’erreur suivent une convention documentée dans `key_ErrWarn.h` :

| Catégorie | Code       |
|-----------|------------|
| Reading   | `1x`       |
| Writing   | `2x`       |
| Pixmap    | `3x`       |
| Bounds    | `4x`       |
| System    | `10x`      |

Chaque fonction `Error*` ou `Warn*` :

- teste une condition (lecture incomplete, width/height hors bornes, pointeur `NULL`, etc.),
- imprime un message sur `stderr`,
- termine le programme avec le code adapté si nécessaire.

### LabVIEW

Le **fil d’erreur** relie tous les SubVIs :

- Si une étape échoue (image corrompue, fichier manquant, exécution C en erreur…),  
  LabVIEW propage l’erreur et arrête l’exécution,
- L’utilisateur voit un message d’erreur explicite.

---

## Algorithmes de détection et d’analyse

### MATLAB – logique de jeu

- À partir des positions de chaque boule, MATLAB :
  - interpole les `NaN` ou corrige les outliers si besoin,
  - calcule la longueur de trajectoire de chaque boule (`GetBallPathLength`),
  - détecte les impacts boule-bande (`GetTouchIdx`),
  - applique la règle de victoire :
    - les 3 boules doivent avoir bougé,
    - la première boule doit toucher au moins 3 bandes entre 2 chocs.

- Le script trace ensuite les trajectoires avec un cadre correspondant au billard et résume:
  - distances parcourues,
  - nombre de boules actives,
  - nombre de bandes touchées (détail différent selon victoire/défaite).

### C – détection des boules

Le cœur de `Pix2Pos.c` :

1. Charge le pixmap binaire dans un tableau (width, height, pixels).
2. Suppose qu’une boule est approximativement un **carré 13×13 pixels**.
3. Glisse ce carré sur toute l’image :
   - pour chaque carré, transforme les pixels en RGB,
   - compte le nombre de pixels dans les intervalles de rouge, jaune, blanc,
   - ignore rapidement un carré si le pixel central est bleu (bord du billard) → optimisation.
4. Pour chaque couleur (rouge, jaune, blanc), garde le carré au **score maximal**.
5. Si le score maximal < `BallMinScore` (15) → boule “non trouvée” (`X=-1`, `Y=-1`, score=0).
6. Écrit les résultats dans `Pos.txt`.

### LabVIEW – orchestration

- **Prétraitement**:
  - détecte une seule fois les bornes intérieures du billard,
  - affiche les images et les convertit en pixmap binaire pour le C.
- **Interaction avec le C**:
  - construit la ligne de commande (`Pix2Pos.exe` + largeur/hauteur + intervalles de couleur + bornes),
  - récupère `Pos.txt` pour chaque image.
- **Interaction avec MATLAB**:
  - convertit les tableaux de coordonnées en chaînes,
  - valide les options d’affichage, réalise un fallback vers des valeurs par défaut en cas d’erreur,
  - génère un script MATLAB exécutable (`AnalyseTx.m`).

---

## Informations de compilation et versions

- **C – compilation** (`Pix2Pos.c` → `Pix2Pos.exe`)  
  - Compilateur conseillé : `gcc` avec optimisation niveau 3 : `-O3`.  
  - Développement sous Ubuntu 20.04 :  
    `gcc (Ubuntu 11.1.0-1ubuntu1~20.04) 11.1.0`  
  - Exécutable Windows compilé sous Windows 11 :  
    `gcc.exe (Rev1, Built by MSYS2 project) 12.1.0`

- **LabVIEW**  
  - Version : **2022 Q3**

- **MATLAB**  
  - Version : **R2022b**

L’ensemble forme une solution multi-langages robuste où **LabVIEW** orchestre le flux de données, **C** fait le traitement bas niveau sur les images, et **MATLAB** fournit une analyse et une visualisation de haut niveau de la partie de billard.