export type ProjectResource = {
    type: "report" | "demo" | "slides";
    label: string;
    url?: string;
    description?: string;
};

export type ProjectTag = "AI" | "Robotics" | "Computer Vision" | "Control" | "Mechanical Design" | "Simulation" | "Embedded";

export type ProjectHero = {
    type: "image" | "video" | "youtube" | "vimeo";
    url: string;
    embedUrl?: string;
    thumbnailUrl?: string;
};

export type Project = {
    slug: string;
    title: string;
    course?: string;
    timeline?: string;
    summary: string;
    description: string;
    highlights: string[];
    tags: ProjectTag[];
    hero?: ProjectHero;
    resources?: ProjectResource[];
    featured?: boolean;
    pdfLabel?: string;
    pdfDescription?: string;
};

export const ProjectsData: Project[] = [
    {
        slug: "lerobot",
        title: "Imitation Learning with Robotic Arm",
        timeline: "12.2025",
        summary: "Assembled the robotic arm, implemented servo control, embedded programming, and developed and trained an imitation learning pipeline.",
        description:
            "This is a real-time teleoperation setup using a leader–follower robotic arm system. The leader arm captures joint motions, which are mapped and mirrored live onto the follower arm through a custom control stack on Ubuntu. This setup allows intuitive, low-latency human control and forms the foundation for learning from demonstration, where the robot can later learn to perform tasks autonomously based on these human-guided trajectories.\\n\\nAfter a large number of episodes are recorded (consisting of time-synchronised camera frames and robot actions), the data is consolidated into a single dataset. Every episode is stored as an ordered sequence of observations, including image frames, actuator commands, and relevant state information. This structured collection captures both successful executions and natural variation, providing a reliable foundation for training robotic control models.",
        highlights: [
            "Real-time teleoperation setup using a leader–follower robotic arm system.",
            "Leader arm captures joint motions mirrored onto follower arm via Ubuntu control stack.",
            "Consolidated dataset from time-synchronized camera frames and robot actions.",
            "Foundation for learning from demonstration and autonomous task performance.",
        ],
        tags: ["Robotics", "Control", "Embedded", "AI"],
        featured: true,
    },
    // {
    //     slug: "soft-arm-sim-to-real",
    //     title: "Soft Robotic Arm: Sim-to-Real Digital Twin & RL",
    //     course: "Robotics Research",
    //     timeline: "12.2025",
    //     summary: "Created a Digital Twin of a soft robotic arm in Isaac Sim to train and deploy RL policies.",
    //     description:
    //         "Bridged the sim-to-real gap for a tendon-driven soft arm by modeling flexible joints in Isaac Sim. Implemented a Constant Curvature controller for unified control and trained RL policies for autonomous manipulation.",
    //     highlights: [
    //         "Modeled soft arm physics in Isaac Sim using approximated revolute joints and tuned damping.",
    //         "Developed a Constant Curvature controller to map simulation commands to real tendon actuation.",
    //         "Established a Sim-to-Real pipeline for deploying RL policies trained in NVIDIA Isaac Sim.",
    //     ],
    //     tags: ["Simulation", "Robotics", "AI", "Control"],
    //     resources: [
    //         {
    //             type: "demo",
    //             label: "Sim-to-Real Demo",
    //             description: "Video comparison of simulation and real robot.",
    //         },
    //     ],
    //     featured: true,
    // },
    {
        slug: "ai-text-audio-hate-speech",
        title: "AI Model Training for Hate Speech Prediction",
        course: "Deep Learning",
        timeline: "02.2025",
        summary: "Fine-tuned a GPT-2 and BERT to anticipate hate speech in partial transcripts.",
        description:
            "This project explored early detection of hate speech by combining acoustic cues with textual transcripts. We benchmarked different fusion strategies, optimized a custom training loop, and focused on minimizing false positives in sensitive conversations.",
        highlights: [
            "Fine-tuned a transformer backbone on curated contextual hate speech datasets.",
            "Designed a fusion layer that learns joint representations from audio spectrograms and transcripts.",
            "Performed error analyses to balance sensitivity with conversational nuance.",
        ],
        tags: ["AI"],
        resources: [
            {
                type: "report",
                label: "Final report (add PDF link)",
                description: "",
            },
        ],
        featured: true,
    },
    {
        slug: "rl-quadruped-training",
        title: "Reinforcement Learning for a Quadruped Robot",
        course: "Legged Robots",
        timeline: "11.2025",
        summary: "Developed and tuned RL policies that stabilized a simulated quadruped across terrains.",
        description:
            "Focused on locomotion control inside OpenAI Gym, contrasting CPG-inspired controllers with policy gradients. Reward shaping and curriculum learning were iterated to achieve smooth gaits and fast convergence.",
        highlights: [
            "Implemented baseline CPG and Cartesian PID controllers for reference trajectories.",
            "Experimented with PPO and SAC, selecting hyperparameters for stability vs. speed.",
            "Crafted terrain-aware reward functions that favored energy-efficient steps.",
        ],
        tags: ["Simulation", "AI", "Robotics", "Control"],
        resources: [
            {
                type: "report",
                label: "Training logbook",
                description: "",
            },
        ],
        featured: true,
    },
    {
        slug: "inverse-rl-research",
        title: "Inverse RL Research",
        course: "Reinforcement Learning",
        timeline: "02.2025 (This semester)",
        summary: "Academic deep-dive into the limitations of popular inverse RL formulations.",
        description:
            "Surveyed MaxEnt IRL, adversarial approaches, and offline variants to propose practical heuristics that reduce demonstration requirements. Focused on reproducibility and lightweight evaluation harnesses.",
        highlights: [
            "Benchmarked state-of-the-art IRL libraries on shared control tasks.",
            "Documented common failure modes tied to reward misspecification.",
            "Outlined research directions for safer covariate shift handling.",
        ],
        tags: ["AI"],
    },
    {
        slug: "chocolate-recognition",
        title: "Chocolate Recognition",
        course: "Image Analysis",
        timeline: "06.2025",
        summary: "Used computer vision to count multiple types of chocolates under diverse backgrounds.",
        description:
            "Prepared a dataset of confectionery arrangements, applied aggressive augmentation, and trained a lightweight detector to separate overlapping sweets before counting instances.",
        highlights: [
            "Automated labeling with synthetic arrangements to extend limited data.",
            "Applied color constancy and histogram equalization for background invariance.",
            "Deployed the detector as a small Flask app for quick demos.",
        ],
        tags: ["Computer Vision"],
        resources: [
            {
                type: "report",
                label: "Lab report placeholder",
                description: "",
            },
        ],
    },
    {
        slug: "robot-vision-navigation",
        title: "Computer Vision Navigation for a Robot",
        course: "Mobile Robotics",
        timeline: "05.2024",
        summary: "Implemented onboard vision and planning so a Thymio robot could reach goals autonomously.",
        description:
            "Combined OpenCV perception with particle filtering and A* planning to follow colored waypoints. Tuned closed-loop behavior for reliable on-table navigation.",
        highlights: [
            "Designed vision pipeline with color segmentation + morphological cleanup.",
            "Estimated robot pose via EKF and fused wheel odometry with visual beacons.",
            "Executed waypoint tracking with obstacle-aware path smoothing.",
        ],
        tags: ["Robotics", "Computer Vision", "Control"],
        featured: true,
    },
    {
        slug: "autonomous-vehicle-mpc",
        title: "Autonomous Vehicle Navigation Using MPC",
        course: "Model Predictive Control",
        timeline: "11.2024",
        summary: "Implemented a simplified autonomous driving stack centered on MPC-based path tracking.",
        description:
            "Evaluated different MPC formulations, modeled vehicle dynamics, and developed a simulation harness to compare controllers under tight turns and obstacles.",
        highlights: [
            "Linearized bicycle model for predictive control under speed constraints.",
            "Benchmarked tracking error vs. compute budget for multiple solvers.",
            "Packaged the stack with visualization overlays for instructor demos.",
        ],
        tags: ["Control", "Simulation"],
        featured: true,
    },
    {
        slug: "autonomous-drone-racing",
        title: "Autonomous Drone Racing",
        timeline: "06.2025",
        summary: "Programmed a Crazyflie drone to fly racing trajectories autonomously with onboard perception.",
        description:
            "Simulated laps with synthetic gates, applied computer vision for gate detection, and transferred motion primitives to hardware while accounting for aerodynamic drift.",
        highlights: [
            "Used ROS + Gazebo to validate trajectories before flight tests.",
            "Incorporated obstacle avoidance modules for pop-up barriers.",
            "Optimized PID gains for tight corners and altitude stability.",
        ],
        tags: ["Robotics", "Computer Vision", "Control", "Simulation"],
        resources: [
            {
                type: "demo",
                label: "Flight demo slot",
                description: "",
            },
        ],
        featured: true,
    },
    {
        slug: "billiard-vision-analysis",
        title: "Billiard Game Analysis through Computer Vision",
        course: "Programming Project",
        timeline: "09.2022",
        summary: "Analyzed billiard dynamics in MATLAB, C, and LabVIEW to identify game outcomes.",
        description:
            "Captured match footage, processed ball trajectories, and extracted statistics to announce winners. Focused on portable tooling for sports analytics experiments.",
        highlights: [
            "Calibrated multi-camera setup and synchronized timestamps.",
            "Implemented collision detection and bounce classification.",
            "Automated scoreboard overlays driven by detection events.",
        ],
        tags: ["Computer Vision"],
    },
    {
        slug: "hand-gesture-drone-swarms",
        title: "Hand Gesture Control for Drone Swarms with VR",
        timeline: "10.2025 (Ongoing)",
        summary: "Designed VR-based hand gesture control that commands the shape and velocity of a drone swarm.",
        description:
            "Uses Meta Quest 3 controllers and dimensionality reduction to convert gestures into swarm formations. Integrates vision feedback and ML classifiers for intent recognition.",
        highlights: [
            "Streams skeletal data from VR hardware into a ROS pipeline.",
            "Explores PCA/U-MAP embeddings for low-latency gesture encoding.",
            "Fuses camera perception to validate formation execution.",
        ],
        tags: ["Robotics", "Computer Vision", "Simulation"],
        pdfLabel: "Final report",
        pdfDescription: "Aerial Swarm Hand Control write-up (PDF).",
        featured: true,
    },
    {
        slug: "carrots-peeler",
        title: "Mechanical Carrot Peeler",
        course: "ME-102/107 Mechanical Construction",
        timeline: "04.2021",
        summary:
            "Designed and machined a fully manual carrot-peeling machine that synchronizes blade travel and carrot rotation with a single crank.",
        description:
            "Engineered a compact peeling machine that satisfies weight, safety, and manufacturability constraints. The mechanism uses twin fork supports, a chain-driven carriage, and a torsion-spring blade that adapts to irregular vegetables.",
        highlights: [
            "One crank simultaneously translates the blade and indexes the carrot 30° per turn.",
            "Torsion-spring blade mount maintains constant contact force without jamming.",
            "Complete machining package (drawings, CAM, BOM) delivered for 3-axis milling.",
        ],
        tags: ["Mechanical Design"],
    },
    {
        slug: "aerial-am",
        title: "Aerial Additive Manufacturing Prototype",
        timeline: "09.2025",
        summary:
            "Designed a drone-based additive manufacturing simulation in Genesis that deposits material in flight for large-scale structures.",
        description:
            "Built an experimental setup where a multirotor carries a lightweight extrusion head and synchronized resin feed. The work focused on toolpath planning, material curing timing, and the control logic that keeps the nozzle aligned while the platform moves.",
        highlights: [
            "Implemented a dual-loop controller that couples flight dynamics with deposition rate.",
            "Validated toolpaths on curved mandrels and vertical surfaces without scaffolding.",
            "Packaged the workflow in ROS2 so future teams can iterate on materials and nozzle designs.",
        ],
        tags: ["Robotics", "Control", "Simulation"],
    },
    // {
    //     slug: "robotic-arm-scaffolding",
    //     title: "Robotic Arm Simulation for Scaffolding Applications",
    //     course: "Introduction to Robotics",
    //     timeline: "2022",
    //     summary: "Simulated inverse kinematics for a robotic arm that assists with scaffolding assembly.",
    //     description:
    //         "Modeled the construction environment in MATLAB, designed IK solvers, and validated real-time feasibility for Hong Kong building codes.",
    //     highlights: [
    //         "Built a kinematic chain model with joint limit enforcement.",
    //         "Integrated collision checking against scaffold elements.",
    //         "Demonstrated real-time control loops for assisted placement.",
    //     ],
    //     tags: ["Robotics", "Control"],
    // },
    {
        slug: "quadcopter-design-stabilization",
        title: "Quadcopter Design and Stabilization",
        timeline: "07.2020",
        summary: "Designed, printed, and stabilized a quadcopter with custom PID loops.",
        description:
            "Produced CAD for the airframe, integrated IMU data, and tuned cascaded PID controllers to maintain hover despite lightweight frames.",
        highlights: [
            "3D printed structural components and optimized for weight.",
            "Developed embedded firmware in C++ for sensor fusion.",
            "Calibrated PID gains using thrust stand measurements.",
        ],
        tags: ["Robotics", "Control", "Mechanical Design"],
    },
    {
        slug: "clickbait-data-analysis",
        title: "Clickbait Data Analysis",
        course: "Applied Data Analysis",
        timeline: "08.2025",
        summary: "Analyzed 72.9M YouTube videos to measure when, and for whom, clickbait actually works.",
        description:
            "Team project for EPFL's Applied Data Analysis course, published as the interactive data story \"You Won't Believe What We Found\". We built a clickbait detector for video titles and combined it with the YouNiverse dataset (136k channels, 72.9M videos) to quantify how widespread clickbait is, how much it boosts views and engagement, and how the payoff differs across content categories and channel sizes.",
        highlights: [
            "Trained a hybrid clickbait classifier on news headlines and Mistral-7B-labeled YouTube titles, using n-grams and \"scream factors\" (caps, punctuation) to reach 76% F1.",
            "Tracked clickbait's rise from ~11% of uploads in 2005 to ~33% in 2019, with 97.8% of channels using it at least once.",
            "Quantified its payoff with Mann-Whitney tests and OLS regressions: up to +81% views in top categories, with small channels benefiting most.",
        ],
        tags: ["AI"],
        resources: [
            {
                type: "demo",
                label: "Data story website",
                url: "https://epfl-ada.github.io/ada-2025-project-datahunt3rs/",
                description: "Interactive data story with the full analysis, visualizations, and findings.",
            },
        ],
    },
    {
        slug: "data-augmentation-box",
        title: "Data Creation Box",
        timeline: "09.2025 (This semester)",
        summary: "Automated the photo capture process for object-recognition datasets using a custom rig.",
        description:
            "Constructed a rotating platform with controllable lighting and backgrounds, scripted camera capture, and paired it with YOLOv12 fine-tuning routines.",
        highlights: [
            "Engineered synchronized motors, lights, and cameras for repeatability.",
            "Implemented scripts that capture multi-angle sequences per object.",
            "Automated training/evaluation cycles for each new SKU.",
        ],
        tags: ["Mechanical Design", "Computer Vision", "AI", "Embedded"],
        resources: [
            {
                type: "report",
                label: "Assembly notes",
                description: "",
            },
        ],
        featured: true,
    },
    {
        slug: "eye-tracker-headlamp",
        title: "Eye Tracker Headlamp",
        timeline: "12.2025",
        summary: "Built a gaze-aware headlamp that aligns light direction with the wearer’s line of sight.",
        description:
            "Combined an optical camera, IR camera, and dual servos driven by a Raspberry Pi 5 to keep the headlamp beam parallel to the detected gaze vector.",
        highlights: [
            "Implemented closed-loop control that corrects aim using camera feedback.",
            "Integrated servo drivers, power delivery, and safety interlocks.",
            "Optimized calibration so users can remap gaze in under a minute.",
        ],
        tags: ["Computer Vision", "Control", "Mechanical Design"],
        resources: [
            {
                type: "report",
                label: "System design doc",
                description: "",
            },
        ],
    },
    {
        slug: "personal-website-simpleplain",
        title: "Personal Website Built on SimplePlain",
        timeline: "01.2023",
        summary: "Customized the SimplePlain template to showcase robotics work, interactive project pages, and inline media viewers.",
        description:
            "Cloned the SimplePlain template and transformed it into a tailored personal site with data-driven sections, immersive project detail routes, and horizontal media rails for reports, videos, and galleries.",
        highlights: [
            "Replaced GitHub auto-fetch with a curated CV-driven dataset for full control over messaging.",
            "Implemented inline PDF + media viewers optimized for 50% viewport height and horizontal scrolling.",
            "Extended routing to support slugged project pages with related-project carousels and responsive layout tweaks.",
        ],
        tags: [],
        resources: [
            {
                type: "demo",
                label: "SimplePlain GitHub",
                url: "https://github.com/pm25/simpleplain",
                description: "Base template used as the starting point for this website.",
            },
        ],
    },
    {
        slug: "virtual-drone-racing",
        title: "Virtual Drone Racing",
        course: "Crazyflie Practical",
        timeline: "07.2025",
        summary:
            "Programmed a Crazyflie to detect gates in Webots, race multiple laps, then port the stack to real hardware.",
        description:
            "Individual simulation tasks required computer-vision gate mapping during lap one, followed by aggressive time-trial laps. Teams then ported the pipeline to the real Crazyflie, tuning PID loops and validating on a smaller arena.",
        highlights: [
            "Gate detection pipeline using OpenCV during the discovery lap.",
            "Lap-aware planner and controller that handles randomized gate placements.",
            "Sim-to-real workflow in ROS2 with best-of-three trials deciding hardware grades.",
        ],
        tags: ["Robotics", "Computer Vision", "Control", "Simulation"],
    },
];

export const FeaturedProjects = ProjectsData.filter((project) => project.featured);
