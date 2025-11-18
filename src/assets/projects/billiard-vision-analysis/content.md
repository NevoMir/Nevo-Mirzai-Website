# Billiard Tracking & Scoring System  
_2022 From image sequences to an automatic score sheet (C + LabVIEW + MATLAB)_

<video src="cover/cover.mp4" controls autoplay muted loop playsinline height="70vh"></video>
---

## Overview

This project turns a **folder of billiard table images** into an **automatic score report** in PDF.

Three tools work together:

- **C**: low-level image processing on a binary pixmap to detect ball positions and scores.
- **LabVIEW**: orchestrates the whole pipeline, calls the C executable, manages errors, passes data around, optionally launches MATLAB.
- **MATLAB**: analyses ball trajectories, checks if the player has won, and generates a **ScoreSheet** PDF with paths and statistics.

The user only needs to point LabVIEW to a sequence of images and choose whether to generate the MATLAB score sheet.

---

## High-level architecture

You can think of the system as three layers:

1. **Acquisition & orchestration (LabVIEW)**
2. **Ball detection on a single frame (C)**
3. **Trajectory analysis & report (MATLAB)**

Data flows in this loop for each frame:

1. LabVIEW opens an image (`*.png`) of the billiard table.
2. LabVIEW converts it to a simple binary format `pixmap.bin`.
3. The C program `Pix2Pos.exe` reads `pixmap.bin`, detects the balls, and writes `Pos.txt`.
4. LabVIEW reads `Pos.txt` and accumulates coordinates over all frames.
5. At the end of the sequence, LabVIEW optionally generates and runs a MATLAB script (`AnalyseTx.m`), which creates `ScoreSheetTx.pdf`.

---

## Data flow in more detail

### 1. LabVIEW: from images to pixmap

Main VI: `Billard2023.vi`

- Reads all images in a selected folder.
- For the **first image**, it detects the **inner bounds of the table** using a DarkBlue color range (cushions):
  - `Trouver_bornes.vi` + helper VIs (`Choose_left`, `Choose_right_bottom`) scan pixels to find the rectangle corresponding to the playing area.
- For each image:
  - `open_image.vi` loads it.
  - `write_pixmap.vi` creates `pixmap.bin`, a binary file containing:
    - width,
    - height,
    - 1D array of pixel values.

### 2. C: detecting ball positions and scores

Main program: `Pix2Pos.c` → `Pix2Pos.exe`

Given `pixmap.bin`, the C program:

- Allocates a dynamic array for all pixels (using `calloc()`).
- Interprets the integers as **RGB pixels**.
- Uses a **color-range based search** to find three balls:
  - **red**, **yellow**, **white**.
- Search strategy:
  - Assume each ball is roughly a **13×13 pixel square**.
  - Slide this square over the table area.
  - For each square, count how many pixels fall inside the color range of each ball.
  - The best score (max count) for each color gives the ball center.
- A **minimum score threshold** (`BallMinScore`) rejects bad detections:
  - If below threshold → ball is considered *not found* → coordinates set to `-1` and score to `0`.
- Finally, writes a simple ASCII file `Pos.txt`:
  ```text
  Red:    Xr, Yr, scorer
  Yellow: Xy, Yy, scorey
  White:  Xw, Yw, scorew