class AIBird extends Bird {
    constructor(x, y, brain) {
        
        super(x, y);
        
        this.brain = brain || new NeuralNetwork([5,10,10,1]);
        this.fitness = 0;
        
        sceneManager.getActiveScene().birds.push(this);
    }

    show(){
        push();
            noStroke();
            fill(color(BIRD_COLOR));
            ellipse(this.pos.x, this.pos.y, this.radius, this.radius);
        pop();
    }

    think(){
        let inputs = [];
        inputs[0] = nextPipe.bottomPipe.x1;
        inputs[1] = this.pos.y;
        inputs[2] = this.velocity;
        inputs[3] = nextPipe.bottomPipe.y1;
        inputs[4] = nextPipe.topPipe.y2;
        let result = this.brain.feedForward(inputs);

        if(result[0] > 0){
            this.jump();
        }
    }

    jump(){
        this.velocity = 0;
        this.velocity -= BIRD_JUMP_POWER;
    }

    update() {

        if(this.pos.y < height - GROUND_HEIGHT){
            this.pos.y += this.velocity;
            this.velocity += GRAVITY;
        }else{
            this.pos.y = height - GROUND_HEIGHT;
        }
        
        if(!this.live) return;

        this.think();

        if (!this.isPlayer){
        }
        
        if (this.pos.y < 0 || this.pos.y > height - GROUND_HEIGHT){
            this.fitness-=3000;
            this.die();
        }

        this.fitness += frameCount;
    }

}