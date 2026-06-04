"use client";

import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  DoughnutController,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartType,
} from "chart.js";
import { Chart } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  DoughnutController,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
);

ChartJS.defaults.font.family = "system-ui, sans-serif";
ChartJS.defaults.maintainAspectRatio = false;

export default function ChartBox({
  type,
  data,
  options,
}: {
  type: ChartType;
  data: any;
  options?: any;
}) {
  return <Chart type={type} data={data} options={options} />;
}
