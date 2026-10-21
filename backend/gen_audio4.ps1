Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$dir = 'C:\Users\Usuario\Documents\Martin\DEV\Ingenieria Inversa\backend\samples'

$s.SetOutputToWaveFile("$dir\historia_computacion.wav")
$s.Speak('Repasemos la historia de la computacion. En 1837, Charles Babbage diseno la maquina analitica, considerada el primer diseno de computadora programable, con la colaboracion de Ada Lovelace, que escribio el primer algoritmo. En 1936, Alan Turing propuso la maquina de Turing, un modelo teorico que definio que significa computar. En 1945, John von Neumann describio la arquitectura de programa almacenado, base de las computadoras modernas. En 1958, Jack Kilby y Robert Noyce inventaron el circuito integrado, que permitio miniaturizar los equipos. En 1971, Intel lanzo el microprocesador cuatro mil cuatro, y en 1975 aparecio la primera computadora personal, la Altair. Finalmente, en 1991, Tim Berners Lee creo la World Wide Web, que conecto a todo el mundo.')

$s.SetOutputToWaveFile("$dir\estadistica_definiciones.wav")
$s.Speak('Definamos los conceptos basicos de la estadistica descriptiva. La media es el promedio de un conjunto de datos, y se calcula sumando todos los valores y dividiendolos por la cantidad de datos. La mediana es el valor que queda en el centro cuando ordenamos los datos de menor a mayor, y es util cuando hay valores atipicos. La moda es el valor que aparece con mayor frecuencia en el conjunto de datos. La varianza mide cuanto se dispersan los datos respecto de la media, y se calcula como el promedio de las diferencias al cuadrado. La desviacion estandar es la raiz cuadrada de la varianza y se expresa en las mismas unidades que los datos. Finalmente, el rango es la diferencia entre el valor maximo y el minimo del conjunto.')

$s.SetOutputToWaveFile("$dir\cambio_climatico.wav")
$s.Speak('Analicemos las causas y consecuencias del cambio climatico. La principal causa es la emision de gases de efecto invernadero, como el dioxido de carbono y el metano, producidos por la quema de combustibles fosiles, la deforestacion y la industria. Esto tiene varias consecuencias: el aumento de la temperatura global, el derretimiento de los glaciares y el aumento del nivel del mar. Otra causa es la agricultura intensiva, que libera metano y oxido nitroso; su consecuencia es la degradacion de los suelos y la perdida de biodiversidad. Tambien la urbanizacion genera islas de calor, que provocan olas de calor mas frecuentes en las ciudades.')

$s.SetOutputToWaveFile("$dir\trafico_urbano.wav")
$s.Speak('Veamos los problemas del trafico urbano y sus posibles soluciones. El primer problema es la congestion vehicular en horas pico; una solucion es implementar carriles exclusivos para transporte publico y sistemas de metro. El segundo problema es la contaminacion del aire por los motores de combustion; se soluciona fomentando vehiculos electricos, bicicletas y transporte publico. El tercer problema son los accidentes de transito; se reducen con limites de velocidad mas estrictos, educacion vial y mejores senalizaciones. El cuarto problema es la falta de estacionamiento; se puede resolver con estacionamientos disuasorios en la periferia y tarifas dinamicas.')

$s.Dispose()
Write-Output 'OK'
