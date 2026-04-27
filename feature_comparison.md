# Feature Comparison: Old vs New Energy Simulator

## Old Version Features (`energy-simulator2.jsx`)
- **Differential Evolution (DE) Optimizer**: A sophisticated global optimization algorithm that searches for the best combination of solar capacity, battery size, and financial parameters to minimize energy costs or maximize ROI.
- **Octopus API Integration**:
  - Month-by-month "Direct API" links that allow users to fetch historical price data for specific regions.
  - Automatic deduping and sorting of price data.
- **JSON Repair Logic**: A robust utility (`repairJSON`) that can fix truncated or malformed JSON strings, specifically tailored for common errors when copying data from the Octopus API browser view.
- **CAGR Calculation**: Financial metric for "Annual Return" (Compound Annual Growth Rate) calculated over a 20-year horizon.
- **Dynamic Energy Profiles**: Synthetic generation of demand and heating profiles based on UK monthly temperatures and heat pump COP curves.
- **Sankey Diagram**: A visual representation of annual energy flows (Solar to Home, Grid to Battery, etc.).

## Current Version Features (`src/App.tsx` - Initial State)
- **Modern UI**: A "Velocity" themed interface with dark mode and glassmorphism.
- **Open-Meteo Integration**: Fetches historical solar irradiance data based on Latitude/Longitude.
- **Usage Data Upload**: Support for CSV uploads of electricity and gas consumption.
- **Interactive Graphs**: Recharts-based visualizations for daily energy flows and state-of-charge (SOC).
- **Basic Simulation**: Core engine for calculating energy balances, though missing the advanced optimizer and multi-array support.

## Feature Gap & Missing Elements
1. **Multi-Array Solar**: The old version supported a single array; the new version needs to support a dynamic list of solar arrays with individual azimuths, tilts, and costs.
2. **DE Optimizer**: Missing from the new version. The "Optimizer" button was just a placeholder.
3. **JSON Repair**: The new version lacked the ability to handle malformed pastes, leading to errors when users copied data from Octopus.
4. **API Link Generator**: Missing the convenient month-by-month historical links.
5. **CAGR Metric**: The "Overview" tab lacked the long-term CAGR/Annual Return stat.

## Implementation Status
- [x] **Multi-Array Solar**: Users can now add/remove multiple solar arrays in the Energy Params tab.
- [x] **DE Optimizer**: Fully ported and integrated. It now optimizes across all solar arrays and battery parameters.
- [x] **JSON Repair**: Integrated into the paste load workflow.
- [x] **Octopus API Links**: Restored for both Import and Export tariffs.
- [x] **CAGR Metric**: Added to the Overview statistics.
