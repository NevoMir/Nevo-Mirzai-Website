import rocketTeamDarkLogo from "./images/logoRocketTeamDarkMode.png";
import rocketTeamLightLogo from "./images/logoRocketTeamLightMode.jpeg";
import epflLogo from "./images/epfl_logo.svg";
import eaiLogo from "./images/logoEAI.png"

export const WorkData = [
  {
    title: "Robotics Intern, Humanoid Learning",
    company: "Embodied AI",
    years: "Feb-Aug 2026",
    logo: eaiLogo,
  },
  {
    title: "Project Lead: Flight Simulation",
    company: "EPFL Rocket Team",
    years: "2021 - 2024",
    // Use dark mode logo by default; light mode logo can be handled in the component
    logo: rocketTeamLightLogo,
    // alternative
    darkLogo: rocketTeamDarkLogo,
  },
  {
    title: "Teaching Assistant, Student Mentor",
    company: "École polytechnique fédérale de Lausanne",
    years: "2022 - 2025",
    logo: epflLogo,
  },
];
