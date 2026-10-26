package com.notasia.clone

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun LoginScreen(vm: AppViewModel) {
  var isSignUp by remember { mutableStateOf(false) }
  var email by remember { mutableStateOf("") }
  var password by remember { mutableStateOf("") }

  Column(
    modifier = Modifier
      .fillMaxSize()
      .padding(32.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text("Lecmap", color = Accent, fontSize = 32.sp, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(4.dp))
    Text("Tus clases, en un mapa", color = TextSecondary, fontSize = 14.sp)
    Spacer(Modifier.height(32.dp))

    OutlinedTextField(
      value = email,
      onValueChange = { email = it },
      label = { Text("Email") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
      colors = inputColors(),
    )
    Spacer(Modifier.height(12.dp))
    OutlinedTextField(
      value = password,
      onValueChange = { password = it },
      label = { Text("Contraseña") },
      singleLine = true,
      visualTransformation = PasswordVisualTransformation(),
      modifier = Modifier.fillMaxWidth(),
      colors = inputColors(),
    )

    vm.authError?.let { msg ->
      Spacer(Modifier.height(8.dp))
      Text(msg, color = Color(0xFFF87171), fontSize = 13.sp)
    }

    Spacer(Modifier.height(20.dp))
    Button(
      onClick = {
        if (isSignUp) vm.signUp(email, password) else vm.signIn(email, password)
      },
      enabled = !vm.authLoading && email.isNotBlank() && password.isNotBlank(),
      modifier = Modifier.fillMaxWidth(),
      colors = ButtonDefaults.buttonColors(containerColor = Accent),
    ) {
      Text(
        when {
          vm.authLoading -> "..."
          isSignUp -> "Crear cuenta"
          else -> "Iniciar sesión"
        },
        color = Bg,
      )
    }

    Spacer(Modifier.height(12.dp))
    OutlinedButton(
      onClick = { isSignUp = !isSignUp },
      modifier = Modifier.fillMaxWidth(),
    ) {
      Text(
        if (isSignUp) "¿Ya tenés cuenta? Iniciá sesión" else "¿No tenés cuenta? Registrate",
        color = TextSecondary,
      )
    }

    // Google OAuth: abrir browser con el flow de Supabase.
    // Se implementa cuando se configure el Client ID de Google Cloud.
    // Spacer(Modifier.height(12.dp))
    // OutlinedButton(onClick = { /* signInWithOAuth */ }) { Text("Continuar con Google") }
  }
}
