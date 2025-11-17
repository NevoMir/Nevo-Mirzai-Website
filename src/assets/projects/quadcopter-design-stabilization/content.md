# Self-stabilising Quadcopter  
Nevò Mirzai Hamadani  

---

## 1. Project goal

The project aims to build a **self-stabilising quadcopter** that:

- reads motion data from an **MPU-6050** (3-axis accelerometer + 3-axis gyroscope),
- estimates the drone’s orientation (tilt angles),
- uses a **PID controller** to compute corrections,
- sends **PWM** commands to the motors via an Arduino UNO to keep the drone as level as possible in the air.

To reduce risk, the work is split into two stages:

1. a **single-axis prototype** to test sensing + PID;
2. a **full quadcopter** based on the Flame Wheel F450 frame.

---

## 2. Mechanical structure

### 2.1 Single-axis prototype

![Prototype, front view](Foto/Prototipo_dal_lato.jpeg)

- Wooden beam pivoted at the centre on two supports.
- One brushless motor at each end of the beam, attached with double-sided tape and string.
- ESCs fixed under the beam and powered by a 3S LiPo battery.
- **MPU-6050** at the centre of the beam, Arduino UNO and a breadboard for wiring.
- Felt pads under the ends of the beam to soften impacts during tests.

This setup lets you test self-stabilisation around one axis only, in a safe and simple way.

### 2.2 Final quadcopter (F450)

![Final quadcopter, fully assembled](Foto/Definitivo_completo.jpeg)

- Flame Wheel **F450** frame with:
  - 4 arms with brushless motors and propellers;
  - 4 ESC 420 Lite;
  - central power distribution board.
- Arduino UNO (powered by a 9 V battery) and **MPU-6050** mounted on the top plate.
- Main 3S 11.1 V LiPo battery mounted underneath and fixed with Velcro.
- 4 small landing legs under the frame for safer take-off and landing.
- All long wires grouped with zip ties to avoid hitting the props.

---

## 3. Electrical layout

### 3.1 Classical schematic

![Classical electrical schematic](Foto/Schema_elettrico_visivo_finale_tipo_2_buono.jpg)

Main connections:

- LiPo battery → power board → ESCs → motors (power stage).
- Arduino outputs (PWM pins) → ESC signal inputs.
- Arduino ↔ MPU-6050 via **I²C** (SDA/SCL).
- Push button on the breadboard to start the main loop.

### 3.2 Visual schematic

![Visual electrical schematic](Foto/Schema_elettrico_visivo_finale_bb22.jpg)

This “visual” version shows how Arduino, breadboard, ESCs, sensor and battery are actually wired, making practical assembly easier.

---

## 4. Motion sensing

### 4.1 Capacitive accelerometer principle

![Capacitive accelerometer principle](Foto/accelerometro_capacitivo1.jpg)

- A tiny “comb-shaped” mass is suspended and moves slightly when accelerated.
- It forms variable **capacitors** with fixed combs on the chip.
- When acceleration changes, the distance between plates changes → the **capacitance** changes.
- The sensor electronics convert these changes into acceleration values.

This capacitive MEMS technology is widely used in phones, cars, drones, etc.

### 4.2 MPU-6050 IMU

![MPU-6050](Foto/MPU_6050.jpg)

The **MPU-6050** combines:

- 3-axis linear accelerometer,
- 3-axis gyroscope,
- I²C communication.

In this project it is used to:

- compute roll and pitch from a combination of accelerometer and gyroscope data (complementary filter),
- get yaw mainly from the gyroscope.

---

## 5. PID stabilisation

To keep the drone level, a **PID controller** acts on the angle error:

\[
u(t) = K_P e(t) + K_I \int e(t)\,dt + K_D \frac{de(t)}{dt}
\]

- **P**: reacts to the current error (present).
- **I**: accumulates past error to remove steady-state offset.
- **D**: uses the rate of change to predict motion and damp oscillations.

Overall PID structure:

![General PID flow](Foto/PID_flusso.png)

In code:

- A PID value is computed **for each axis** (X, Y, Z).
- The PID contributions are added to a base throttle value to obtain final PWM signals.
- PWM values are limited between safe min–max bounds before being sent to the ESCs.

---

## 6. Arduino software structure (short overview)

1. **Setup**
   - Initialise Serial and I²C.
   - Wake up the MPU-6050, set the correct registers.
   - Attach motors to PWM pins (`Servo.attach`) and send initial values (~1150 µs).
   - Measure and store the **sensor offsets** while the drone is still (calibration).
   - Wait for the button press to start control (`loop`).

2. **Loop**
   - Read raw data from MPU-6050 registers via I²C.
   - Combine high/low bytes, convert to physical units:
     - accelerations in m/s²,
     - angular rates in °/s.
   - Compute angles:
     - from accelerations (arctan),
     - from integrating gyroscope data,
     - then combine them (complementary filter).
   - Compute the PID for each axis using the angle error.
   - Add a time-varying lift profile (parabola + hyperbola in time) to perform smoother take-off and landing rather than a sudden step in throttle.
   - Send final PWM values to each motor with `writeMicroseconds`.

---

## 7. Results and limitations

- **Prototype (single axis)**  
  Works reasonably well: when you manually disturb the beam, the motors react quickly and try to return it to horizontal.

- **Final quadcopter**  
  - The motors react correctly to manually induced tilts.
  - However, there are still **sudden thrust jumps** and incomplete damping.
  - Full free flight is not yet safe, so tests are done while partially holding the drone.

The main difficulty is tuning the **9 PID gains** (P, I, D for 3 axes). Without a radio link to adjust gains in real time, optimisation is slow and trial-and-error based.

---

## 8. Possible improvements

- Integrate an RC transmitter/receiver so the pilot can:
  - control the drone,
  - adjust PID gains during flight (e.g. via trims).
- Add extra sensors (barometer, GPS, optical flow) for altitude and position holding.
- Use more advanced filtering/estimation (e.g. Kalman filter) for better attitude estimation.
- Once attitude control is robust, extend to autonomous navigation (e.g. waypoint following or obstacle avoidance).