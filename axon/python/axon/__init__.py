"""
Axon — CPU-optimized fine-tuning for language models
Copyright (c) 2024 Max (Ravikxx) / Axion Labs
Licensed under the Apache License 2.0
"""

from .trainer  import AxonTrainer
from .config   import AxonConfig
from .hardware import detect_hardware, HardwareProfile
from .memory   import plan as plan_memory, MemoryPlan

__version__ = "0.1.0"
__author__  = "Max (Ravikxx) / Axion Labs"
__license__ = "Apache-2.0"

__all__ = [
    "AxonTrainer",
    "AxonConfig",
    "detect_hardware",
    "HardwareProfile",
    "plan_memory",
    "MemoryPlan",
]
