@echo off
rem Run a Python module with the Windows tool-pack interpreter only.
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"
call "%~dp0_find_python.bat"
if not defined PYTHON_EXE (
  echo error: Windows tool-pack Python is missing. Run run\win\setup_exe.bat first.
  popd
  exit /b 1
)
if "%~1"=="" (
  echo usage: run\win\run_python.bat module [arguments]
  popd
  exit /b 2
)

"%PYTHON_EXE%" -c "import runpy, sys; sys.path.insert(0, r'%REPO_ROOT%'); module = sys.argv[1]; sys.argv = sys.argv[1:]; runpy.run_module(module, run_name='__main__')" %*
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
