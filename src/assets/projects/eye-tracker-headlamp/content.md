# Eye Tracking Headlamp (ETHL)
2024 • *A motorized headlamp that tracks your eyes to provide hands-free, targeted illumination exactly where you look.*

<video src="cover/cover.mp4" controls autoplay muted loop playsinline height="50vh"></video>

---

## Overview

[cite_start]This project addresses a critical issue for technicians working in **cramped, high-stakes environments**—from aircraft mechanics inside a wing to astronauts on the ISS[cite: 6, 14]. In these spaces, manual adjustment of lighting is often impossible, yet standard headlamps fail to illuminate the periphery effectively.

**ETHL** is a proof-of-concept wearable system that:
* [cite_start]Tracks the user's **eye gaze** in real-time using an infrared camera[cite: 39].
* [cite_start]Actuates a **2-axis servo turret** to physically move the headlamp[cite: 39].
* [cite_start]Ensures the beam's "sweet spot" (100% intensity) aligns perfectly with the user's line of sight without hands-free interaction[cite: 16].

---

## Demo videos

### 1. Full System Demonstration
The complete prototype running on the helmet, showing the lamp following gaze in real-time.
<!-- 
<video src="videos/full-system-demo.mp4" controls autoplay muted loop playsinline height="50vh"></video>


### 2. Eye Tracking Feed
The raw input from the Infrared (IR) camera processing pupil movement.

<video src="videos/eye-tracking-feed.mp4" controls autoplay muted loop playsinline height="50vh"></video>

### 3. Light Actuation (Turret Test)
Testing the 2-axis servo motor turret response independent of the helmet.

<video src="videos/light-actuation.mp4" controls autoplay muted loop playsinline height="50vh"></video>

### 4. Calibration: Gaze Mapped to Optic Camera
A view from the front-facing optical camera with the gaze point overlaid, verifying alignment with the real world.

<video src="videos/calibration-view.mp4" controls autoplay muted loop playsinline height="50vh"></video>

### 5. Unified View: Eye Tracking + Optic Camera
Side-by-side comparison showing the eye movement (input) and the resulting environmental alignment (output).

<div style="display: flex; gap: 10px; width: 100%; justify-content: center;">
  <video src="videos/eye-view.mp4" controls autoplay muted loop playsinline style="width: 48%; height: auto;"></video>
  <video src="videos/optic-view.mp4" controls autoplay muted loop playsinline style="width: 48%; height: auto;"></video>
</div>
-->
---

## The Problem: Non-Linear Light Drop-off

Standard headlamps are static. If you move your eyes without moving your head, you lose significant visibility.
[cite_start]Research shows a sharp non-linear drop-off in light intensity[cite: 15, 26]:

* [cite_start]**0° (Center):** 100% Intensity [cite: 27]
* [cite_start]**20° (Half-Angle):** ~50% Intensity [cite: 28]
* [cite_start]**40° (Field Angle):** ~10% Intensity [cite: 29]

[cite_start]If a mechanic looks just **20° off-center**, they lose **half** their illumination[cite: 15]. [cite_start]The ETHL solves this by mechanically steering the 100% intensity region to the user's gaze vector[cite: 16].
<!-- 
<img src="images/light-intensity-graph.webp" alt="Light intensity distribution graph" height="50vh" />
-->
---

## System Architecture

[cite_start]The device is a self-contained, head-mounted unit powered by a **2.5Ah battery pack**[cite: 41].

[cite_start]**Hardware Stack** [cite: 39, 40, 41]
* **Processing:** Raspberry Pi processing gaze data in real-time.
* **Sensors:**
    * *IR Camera:* For pupil tracking (gaze estimation).
    * *Optical Camera:* For beam recognition and environment mapping.
* **Actuation:** Servo motors driving a custom 3D-printed gimbal (turret).
* **Structure:** Custom CAD parts designed to hold components compactly on a standard safety helmet.

**Process Flow**
1.  IR Camera captures eye position.
2.  Raspberry Pi computes the gaze vector.
3.  System calculates required servo angles (Pan/Tilt).
4.  Servos orient the lamp to the target coordinates.

---
<!-- 
## Performance & Future Steps

**Current Status**
[cite_start]We successfully demonstrated a prototype that aligns illumination with user gaze, validating the feasibility of hands-free lighting control[cite: 52].
[cite_start]Currently, no commercial headlamp exists that steers its beam based on actual eye-tracking[cite: 43].

**Key Metrics**
[cite_start]The main performance metrics for the system include[cite: 49]:

| Metric | Goal (Theory) |
| :--- | :--- |
| **Accuracy** | ±5° |
| **Response Time** | < 1s |
| **Range (Max Angle)** | ±40° |

[cite_start]**Future Development** [cite: 53, 54]
* **Miniaturization:** Integrating cameras directly into safety glasses.
* **Optimization:** Improving tracking accuracy and reducing response latency.
* **Ergonomics:** Better weight distribution for long-term comfort.
* **Testing:** Advanced condition testing (dynamic movements, varying ambient light).
-->