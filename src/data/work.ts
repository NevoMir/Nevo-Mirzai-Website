import rocketTeamDarkLogo from "./images/logoRocketTeamDarkMode.png";
import rocketTeamLightLogo from "./images/logoRocketTeamLightMode.jpeg";
import epflLogo from "./images/epfl_logo.svg";

export const WorkData = [
  {
    title: "Mechanical Engineer",
    company: "EPFL Rocket Team",
    years: "2021 - 2024",
    // Use dark mode logo by default; light mode logo can be handled in the component
    logo: rocketTeamLightLogo,
    // alternative
    darkLogo: rocketTeamDarkLogo,
  },
  {
    title: "Student Mentor",
    company: "École polytechnique fédérale de Lausanne",
    years: "2022 - 2025",
    logo: epflLogo,
  },
  {
    title: "Teaching Assistant",
    company: "École polytechnique fédérale de Lausanne",
    years: "2022 - 2024",
    logo: epflLogo,
  },
];
