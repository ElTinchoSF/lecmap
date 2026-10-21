Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile('C:\Users\Usuario\Documents\Martin\DEV\Ingenieria Inversa\backend\uploads\calculo_vectorial.wav')
$s.SelectVoiceByHints('Female', 'Spanish')
$s.Speak('Hoy vamos a ver dos teoremas fundamentales del cálculo vectorial. Primero, el teorema de Green. El teorema de Green relaciona una integral de línea sobre una curva cerrada C con una integral doble sobre la región R encerrada por C. Su fórmula es la integral sobre C de L dx más M dy, igual a la integral doble sobre R de la derivada parcial de M respecto de x, menos la derivada parcial de L respecto de y, dx dy. Este teorema se usa para calcular áreas y en mecánica de fluidos. Segundo, el teorema de Stokes. El teorema de Stokes generaliza el teorema de Green al espacio tridimensional y relaciona la integral de línea de un campo vectorial sobre una curva cerrada con la integral de superficie del rotacional sobre una superficie cuya frontera es esa curva. Se aplica en electromagnetismo para deducir la ley de Faraday y en el estudio del flujo de campos vectoriales. Tanto Green como Stokes son casos particulares del teorema general de Stokes.')
$s.Dispose()
Write-Output 'OK'
