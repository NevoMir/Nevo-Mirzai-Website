# Hand Gesture Control for Drone Swarms with VR
_Independent • 2024 (Ongoing)_

<img src="cover/cover.png" alt="Gesture interface" height="50vh" />

<video src="videos/BOUND_HIGH_1_07ms.mp4" controls autoplay muted loop playsinline height="50vh"></video>

## Goals

- Stream skeletal data from the Meta Quest 3 controllers.
- Learn a gesture-to-formation mapping that supports quick demos.
- Validate intent through the onboard vision system before committing the swarm.

## Dataset & Tooling

- Recordings collected inside the EPFL flying arena.
- Gesture feature extraction handled by a small Python/NumPy notebook.
- Training notebooks shared internally (ask for `gesture-notebook.ipynb`).

## Slides

<div class="relative w-full max-w-4xl aspect-video mx-auto overflow-hidden rounded-md my-6">
    <iframe
        class="absolute top-0 left-0 w-full h-full"
        src="https://docs.google.com/presentation/d/1FshBk1suVUCHNCBTP1fp5eQhe4eJct6a/embed?start=false&loop=false&delayms=10000"
        allowfullscreen
        title="Hand Gesture Swarm Deck"
    ></iframe>
</div>

## Next Steps

1. Add an out-of-distribution detector before sending commands to the drones.
2. Bring the new ROS2 drivers upstream so the rest of the team can pilot quickly.
3. Continue collecting gestures for collaborative patterns (i.e., multi-swarm choreographies).
