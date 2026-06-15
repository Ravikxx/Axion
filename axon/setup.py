"""
Build script for the axon_core C++ extension.

Running `pip install -e .` from the axon/ directory will:
  1. Compile the C++ sources via CMake
  2. Install the axon Python package in editable mode

For development: pip install -e ".[dev]"
"""

import os
import subprocess
import sys
from pathlib import Path

from setuptools import Extension, setup
from setuptools.command.build_ext import build_ext


class CMakeBuild(build_ext):
    """Custom build step that calls CMake instead of the default compiler."""

    def build_extension(self, ext):
        build_dir = Path(self.build_temp) / ext.name
        build_dir.mkdir(parents=True, exist_ok=True)

        source_dir = Path(__file__).parent.resolve()

        # Where the compiled .so ends up
        ext_dir = Path(self.get_ext_fullpath(ext.name)).parent.resolve()

        cmake_args = [
            f"-DCMAKE_LIBRARY_OUTPUT_DIRECTORY={ext_dir}",
            f"-DPYTHON_EXECUTABLE={sys.executable}",
            "-DCMAKE_BUILD_TYPE=Release",
        ]

        build_args = ["--config", "Release", "-j", str(os.cpu_count() or 4)]

        subprocess.run(
            ["cmake", str(source_dir), *cmake_args],
            cwd=build_dir,
            check=True,
        )
        subprocess.run(
            ["cmake", "--build", ".", *build_args],
            cwd=build_dir,
            check=True,
        )


setup(
    name="axon-training",
    ext_modules=[Extension("axon_core", sources=[])],  # sources managed by CMake
    cmdclass={"build_ext": CMakeBuild},
    package_dir={"": "python"},
    packages=["axon"],
    zip_safe=False,
)
